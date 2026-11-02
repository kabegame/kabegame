/**
 * 泛光链的链路隔离验证（PLAN D13，dev 专用，经 `window.__kabegameSceneProbe.bloom` 调用）。
 *
 * 输入 WPE 抓帧导出的泛光链输入（整帧快照，RenderDoc 存的 RGBA16F `.dds` 或 RGBA8 `.png`）与场景的泛光参数，
 * 跑我们的泛光链 + combine（与渲染器同一份 `BloomChain`、同一份 WPE 着色器原件），读回第一步、泛光结果
 * （LDR `_rt_Bloom` / HDR L0）与最终输出，和 WPE 的对应纹理逐像素比较：
 * - 8 位纹理（LDR）按 0–255 比；
 * - HDR 中间结果按浮点比，相对误差 = |差| / max(|WPE|, 1/255)；
 * - HDR 最终输出：WPE 的后备缓冲是线性 FP16（`saturate(lin(x))`），按 sRGB 编码成 8 位后再和我们的输出（画布上的 8 位）比。
 *
 * 图片一律经 GPU 纹理上传、读回，不走 2D 画布：RenderDoc 存的 RT 的 alpha 常为 0，过 2D 画布会因预乘把 RGB 清掉。
 */
import { compileBloom, type BloomPassName } from "../compile/bloom";
import { FetchSceneReader, SceneFs } from "../compile/fs";
import { BLOOM_DEFAULTS, type BloomParams } from "../compile/postprocess";
import { ShaderCompiler } from "../compile/shader";
import { fileToUrl } from "../fileUrl";
import { loadWpesl2wgsl, type TranslateResult } from "../wpesl2wgsl";
import { BloomChain, type BloomStep } from "../render/bloom";
import { acquireGpu } from "../render/device";
import { createPipeline, createProgram, type GpuProgram } from "../render/programs";
import { HDR_TARGET_FORMAT, SCENE_TARGET_FORMAT } from "../render/scene";
import { encodePng, halfTable, quantize8, scheduleReadback, storeProbeBytes, type ReadbackFormat } from "./probe";

export interface BloomProbeOptions {
  /** WPE 的 `assets` 目录（泛光材质与着色器从这里读，与渲染器相同）。 */
  assets: string;
  hdr: boolean;
  /** 场景的泛光参数（WPE 实际用的值，抓帧常量缓冲里读得到）；缺的取默认值。 */
  params?: Partial<BloomParams>;
  /** 泛光链输入：WPE 的整帧快照。 */
  input: string;
  /** WPE 的对照纹理：`first` = 第一步输出（1/4 或 L0 下采样后）、`result` = `_rt_Bloom` / L0（上采样后）、`output` = 后备缓冲。 */
  references?: { first?: string; result?: string; output?: string };
  /** 结果的存放键前缀（`<key>-output.png` 等）。 */
  key?: string;
  /** 另外读回每一步的目标并报尺寸与均值（定位是哪一个 pass 出的差）。 */
  steps?: boolean;
}

interface Image {
  width: number;
  height: number;
  format: ReadbackFormat;
  data: Uint8Array | Float32Array;
}

export interface DiffStats {
  /** 比较的通道数（RGB）。 */
  values: number;
  mean: number;
  p99: number;
  max: number;
  /** 超过各阈值的通道占比。 */
  over: Record<string, number>;
  /** 差最大的一个通道。 */
  worst: { x: number; y: number; channel: number; ours: number; wpe: number };
}

/** 读文件：`.dds`（DX10 头、DXGI_FORMAT_R16G16B16A16_FLOAT）或浏览器能解码的图片。 */
async function readImageFile(device: GPUDevice, path: string): Promise<{ texture: GPUTexture; image: Image }> {
  const response = await fetch(fileToUrl(path));
  if (!response.ok) throw new Error(`读不到 ${path}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (path.toLowerCase().endsWith(".dds")) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x20534444) throw new Error(`不是 DDS：${path}`);
    const height = view.getUint32(12, true),
      width = view.getUint32(16, true);
    const fourCC = String.fromCharCode(...bytes.subarray(84, 88));
    if (fourCC !== "DX10" || view.getUint32(128, true) !== 10)
      throw new Error(`只认 DX10 头的 R16G16B16A16_FLOAT：${path}`);
    const pixels = bytes.subarray(148, 148 + width * height * 8);
    const texture = device.createTexture({
      label: path,
      size: { width, height },
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    device.queue.writeTexture({ texture }, pixels, { bytesPerRow: width * 8 }, { width, height });
    const table = halfTable();
    const halves = new Uint16Array(pixels.slice().buffer);
    const data = new Float32Array(halves.length);
    for (let i = 0; i < halves.length; i++) data[i] = table[halves[i]];
    return { texture, image: { width, height, format: "rgba16float", data } };
  }
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const { width, height } = bitmap;
  const texture = device.createTexture({
    label: path,
    size: { width, height },
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture(
    { source: bitmap },
    { texture, premultipliedAlpha: false },
    { width, height },
  );
  bitmap.close();
  const encoder = device.createCommandEncoder();
  const read = scheduleReadback(device, encoder, texture, width, height, "rgba8unorm");
  device.queue.submit([encoder.finish()]);
  return { texture, image: { width, height, format: "rgba8unorm", data: await read() } };
}

/** sRGB 编码（`lin()` 的反函数，chilliant 的精确式），WPE 线性后备缓冲 → 画布上的编码值。 */
function encodeSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** 两张同尺寸图的 RGB 逐通道差。`scale` 把值换成比较单位（8 位为 1、浮点为 1），`floor` 给相对误差用。 */
export function diffStats(
  ours: ArrayLike<number>,
  wpe: ArrayLike<number>,
  width: number,
  thresholds: number[],
  relativeFloor?: number,
): DiffStats & { relative?: DiffStats } {
  const count = (ours.length / 4) * 3;
  const diffs = new Float32Array(count);
  const rel = relativeFloor === undefined ? null : new Float32Array(count);
  let sum = 0,
    max = 0,
    worst = { x: 0, y: 0, channel: 0, ours: 0, wpe: 0 };
  let n = 0;
  for (let i = 0; i < ours.length; i += 4)
    for (let c = 0; c < 3; c++) {
      const a = ours[i + c],
        b = wpe[i + c];
      const d = Math.abs(a - b);
      diffs[n] = d;
      if (rel) rel[n] = d / Math.max(Math.abs(b), relativeFloor!);
      sum += d;
      if (d > max) {
        max = d;
        const pixel = i / 4;
        worst = { x: pixel % width, y: Math.floor(pixel / width), channel: c, ours: a, wpe: b };
      }
      n++;
    }
  const summarize = (values: Float32Array, total: number, top: number, extra = worst): DiffStats => {
    const over: Record<string, number> = {};
    for (const t of thresholds) {
      let k = 0;
      for (let i = 0; i < values.length; i++) if (values[i] > t) k++;
      over[`>${t}`] = k / values.length;
    }
    return {
      values: values.length,
      mean: total / values.length,
      p99: percentile(values, 0.99, top),
      max: top,
      over,
      worst: extra,
    };
  };
  const stats: DiffStats & { relative?: DiffStats } = summarize(diffs, sum, max);
  if (rel) {
    let rsum = 0,
      rmax = 0;
    for (let i = 0; i < rel.length; i++) {
      rsum += rel[i];
      if (rel[i] > rmax) rmax = rel[i];
    }
    stats.relative = summarize(rel, rsum, rmax);
  }
  return stats;
}

/** 直方图求分位数（10000 个等宽桶，取桶下沿：精度 max / 10000，整数差恰好落在桶下沿上）。 */
function percentile(values: Float32Array, q: number, max: number): number {
  if (max <= 0) return 0;
  const bins = new Uint32Array(10001);
  for (let i = 0; i < values.length; i++) bins[Math.min(10000, Math.floor((values[i] / max) * 10000))]++;
  const target = q * values.length;
  let seen = 0;
  for (let b = 0; b <= 10000; b++) {
    seen += bins[b];
    if (seen >= target) return (b / 10000) * max;
  }
  return max;
}

function to8(image: Image): Uint8Array {
  return image.data instanceof Uint8Array ? image.data : quantize8(image.data);
}

function channelMeans(data: ArrayLike<number>): number[] {
  const sums = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) sums[c] += data[i + c];
  return sums.map((s) => s / (data.length / 4));
}

export async function runBloomProbe(options: BloomProbeOptions) {
  const key = options.key ?? `bloom-${Date.now()}`;
  const params: BloomParams = {
    ...BLOOM_DEFAULTS,
    tint: [...BLOOM_DEFAULTS.tint],
    ...options.params,
  };
  // 编译：与 compileScene 同一份 compileBloom，SceneFs 只挂 assets
  const translator = await loadWpesl2wgsl();
  const reader = new FetchSceneReader();
  const fs = new SceneFs(options.assets, [options.assets], reader);
  const unsupported = new Set<string>();
  const results: TranslateResult[] = [];
  const bloom = await compileBloom(
    {
      fs,
      shader: new ShaderCompiler(fs, translator, unsupported),
      unsupported,
      addProgram: (result) => {
        const index = results.indexOf(result);
        if (index >= 0) return index;
        results.push(result);
        return results.length - 1;
      },
    },
    options.hdr,
  );
  if (unsupported.size) throw new Error(`泛光材质编译失败：${[...unsupported].join("; ")}`);

  const gpu = await acquireGpu();
  const device = gpu.device;
  const owned: { destroy(): void }[] = [];
  try {
    const { texture: input, image: inputImage } = await readImageFile(device, options.input);
    owned.push(input);
    const format = options.hdr ? HDR_TARGET_FORMAT : SCENE_TARGET_FORMAT;
    if ((input.format === "rgba16float") !== options.hdr)
      throw new Error(`输入格式 ${input.format} 与 ${options.hdr ? "HDR" : "LDR"} 不符`);
    const { width, height } = inputImage;
    const programs = new Map<number, GpuProgram>();
    const warnings: string[] = [];
    for (const [index, result] of results.entries())
      programs.set(index, await createProgram(device, result, index, warnings));
    const output = device.createTexture({
      label: "bloom probe output",
      size: { width, height },
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
    owned.push(output);
    // 后备缓冲本来就是场景：combine 只写 RGB，先拷一份，alpha 保持输入
    const prepare = device.createCommandEncoder();
    prepare.copyTextureToTexture({ texture: input }, { texture: output }, { width, height });
    device.queue.submit([prepare.finish()]);

    const chain = await BloomChain.create({
      device,
      bloom,
      params,
      programs,
      format,
      width,
      height,
      source: input.createView(),
      pipelineFor: (program, blending, target) => createPipeline(device, program, blending, target, false),
      own: (resource) => {
        owned.push(resource);
        return resource;
      },
    });
    const { plan } = chain;
    const reads = new Map<string, () => Promise<Uint8Array | Float32Array>>();
    const stepReads: {
      index: number;
      pass: BloomPassName;
      size: string;
      read: () => Promise<Uint8Array | Float32Array>;
    }[] = [];
    const targetFormat = format as ReadbackFormat;
    const encoder = device.createCommandEncoder({ label: "bloom probe" });
    const lastPyramidStep = plan.steps.length - 2;
    const started = performance.now();
    chain.encode(encoder, output.createView(), (index: number, step: BloomStep, enc: GPUCommandEncoder) => {
      if (step.target.kind !== "target") return;
      const target = chain.targets[step.target.index];
      const read = () => scheduleReadback(device, enc, target.texture, target.width, target.height, targetFormat);
      if (index === 0) reads.set("first", read());
      if (index === lastPyramidStep && step.target.index === plan.result) reads.set("result", read());
      if (options.steps)
        stepReads.push({ index, pass: step.pass, size: `${target.width}x${target.height}`, read: read() });
    });
    reads.set("output", scheduleReadback(device, encoder, output, width, height, targetFormat));
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    const gpuMs = performance.now() - started;

    const ours: Record<string, Image> = {};
    for (const [name, read] of reads) {
      const target = name === "output" ? { width, height } : chain.targets[name === "first" ? 0 : plan.result];
      ours[name] = { width: target.width, height: target.height, format: targetFormat, data: await read() };
    }
    const report: Record<string, unknown> = {
      hdr: options.hdr,
      size: `${width}x${height}`,
      levels: plan.levels,
      targets: plan.targets.map((t) => `${t.name} ${t.width}x${t.height}`),
      passes: plan.steps.map((s) => s.pass),
      constants: plan.steps[0].constants,
      warnings,
      gpuMs: Math.round(gpuMs * 10) / 10,
      inputMean: channelMeans(inputImage.data),
    };
    if (options.steps)
      report.steps = await Promise.all(
        stepReads.map(async (s) => ({
          index: s.index,
          pass: s.pass,
          size: s.size,
          mean: channelMeans(await s.read()),
        })),
      );

    // 结果存成 PNG（8 位；HDR 中间结果按 [0, 1] 截断，只供肉眼看）
    for (const [name, image] of Object.entries(ours))
      storeProbeBytes(`${key}-${name}.png`, await encodePng(to8(image), image.width, image.height));

    const comparisons: Record<string, unknown> = {};
    for (const [name, path] of Object.entries(options.references ?? {})) {
      if (!path || !ours[name]) continue;
      const { texture, image: wpe } = await readImageFile(device, path);
      texture.destroy();
      const mine = ours[name];
      if (wpe.width !== mine.width || wpe.height !== mine.height) {
        comparisons[name] = { error: `尺寸不同：WPE ${wpe.width}x${wpe.height}，我们 ${mine.width}x${mine.height}` };
        continue;
      }
      if (name === "output" && options.hdr) {
        // WPE 后备缓冲是线性值：sRGB 编码成 8 位后与画布上的 8 位比
        const encoded = new Uint8Array(wpe.data.length);
        for (let i = 0; i < wpe.data.length; i++)
          encoded[i] = Math.round(Math.min(1, Math.max(0, encodeSrgb(Math.min(1, Math.max(0, wpe.data[i]))))) * 255);
        comparisons[name] = {
          unit: "8 位（WPE 线性后备缓冲按 sRGB 编码）",
          ...diffStats(to8(mine), encoded, mine.width, [0, 1, 2, 4]),
          oursMean: channelMeans(to8(mine)),
          wpeMean: channelMeans(encoded),
        };
        storeProbeBytes(`${key}-wpe-${name}.png`, await encodePng(encoded, wpe.width, wpe.height));
      } else if (wpe.format === "rgba16float") {
        comparisons[name] = {
          unit: "浮点（相对误差 = |差| / max(|WPE|, 1/255)）",
          ...diffStats(mine.data, wpe.data, mine.width, [1 / 255, 2 / 255, 4 / 255], 1 / 255),
          oursMean: channelMeans(mine.data),
          wpeMean: channelMeans(wpe.data),
        };
      } else {
        comparisons[name] = {
          unit: "8 位",
          ...diffStats(to8(mine), wpe.data, mine.width, [0, 1, 2, 4]),
          oursMean: channelMeans(to8(mine)),
          wpeMean: channelMeans(wpe.data),
        };
      }
    }
    report.comparisons = comparisons;
    report.key = key;
    return report;
  } finally {
    for (const resource of owned) resource.destroy();
    device.destroy();
  }
}
