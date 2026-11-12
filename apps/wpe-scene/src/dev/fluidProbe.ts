/**
 * 流体 effect 的单步隔离与长程回放（P7d 步骤 3 验收，dev 专用，经 `window.__kabegameSceneProbe.fluid` 调用）。
 *
 * 和 `renderFrame` 的区别：`renderFrame` 的回放只步进粒子、最后编码一帧；流体的模拟在 effect 的 fbo 里，跨帧保留，所以这里
 * **每帧完整编码一次**（`sync` → `stepParticles` → `setCamera` → `setParallax` → `update` → `encode` → 提交，同渲染器与
 * `renderFrame` 的 profile 帧），逐帧的 `g_Frametime` / `g_Time` / 指针由调用方给（取自 WPE 抓帧的常量缓冲）。
 *
 * 用法：
 * - **单步隔离**：建好场景后把图层 effect 的 fbo 换成 WPE 这一帧开始时的内容（`inject`，RenderDoc 存的 DDS，经 `fetch(file:)` 读，
 *   文件要放在已导入的场景目录里宿主才读得到），按这一帧的 uniform 跑一帧，读回 fbo，和 WPE 这一帧结束时的内容比；
 * - **长程**：从清空的状态起按给定的帧时间序列跑 N 帧，在指定帧读回画布（`canvas`，按 `fill` 铺满，同 WPE 测试窗口）。
 *
 * fbo 的名字：WPE 的 `swap` 不交换纹理，只改各 pass 读写的下标（rea-p7d-fluid 第 3 节第 3 条），我们改名字 → 实体的对应
 * （`FboBindings`），两者等价。`inject` 按**建好场景时**（第 1 帧开始时）扮演这个名字的实体写；读回按**读回那一帧开始时**扮演这个
 * 名字的实体取（即这一帧的 swap 之前，WPE 抓帧「这一帧开始时某名字对应哪张纹理」的口径），结果里另给每个名字当时对应的初始实体。
 *
 * 原始数据经 `storeProbeBytes` 存、`chunk` 取：半精度格式转成 float32（小端）、`rgba8unorm` 原样（RGBA 字节）。
 */
import { compileSceneInWorker } from "../compile/client";
import { TextureDecodeCache } from "../compile/decode";
import { FetchSceneReader } from "../compile/fs";
import type { ScenePostprocessSetting } from "../compile/postprocess";
import { fileToUrl } from "../fileUrl";
import {
  BLIT_SAMPLER,
  createBlitBindGroup,
  createBlitPipeline,
  encodeBlit,
  PLACEMENT_BYTES,
  placementUniform,
} from "../render/blit";
import { acquireGpu } from "../render/device";
import { scenePlacement } from "../render/layout";
import { advanceParallax, drawParallax, initialParallaxState, parallaxInput } from "../render/parallax";
import { GpuScene } from "../render/scene";
import { shakeOffset } from "../render/shake";
import { SceneState } from "../render/state";
import { halfBitsToFloat, parseDds } from "./dds";
import { storeProbeBytes } from "./probe";
import { checkCanvas, windowPointer, type Point } from "./replayPointers";

/** 一帧的输入：WPE 抓帧常量缓冲里的值。 */
export interface FluidFrame {
  /** `g_Frametime`（秒）。 */
  frametime: number;
  /** `g_Time`（秒）。 */
  time: number;
  /** `g_PointerPosition`（抓帧窗口归一化，原点左上、y 朝下、不钳制）；缺省沿用上一帧，第 1 帧缺省 `[0.5, 0.5]`。 */
  pointer?: [number, number];
  /** `g_PointerPositionLast`；缺省为上一帧的 `pointer`（第 1 帧为自己）。 */
  pointerLast?: [number, number];
}

export interface FluidProbeOptions {
  projectDir: string;
  sceneAssets: string[];
  postprocess?: ScenePostprocessSetting;
  userProperties?: Record<string, unknown>;
  /** 有不支持项也渲染（同 dev 强制渲染）。默认 true。 */
  force?: boolean;
  /** 带 effect 的图层（`objects` 下标）；缺省取 bundle 里第一个有 effect 的图层。 */
  object?: number;
  /** 图层上第几个 effect，缺省 0。 */
  effect?: number;
  /** 建好场景后、第 1 帧之前，把这些 fbo（按此刻扮演的名字）换成文件内容。格式与尺寸要和 fbo 相同，否则抛错。 */
  inject?: { name: string; file: string }[];
  /** 逐帧输入，每帧完整编码一次。 */
  frames: FluidFrame[];
  /** 抓帧窗口 `[宽, 高]`：指针按 `fill` 换算出控制点的 cursor（同 `renderFrame`）；缺省取 `canvas`，都没有时原样。 */
  window?: [number, number];
  /** 在哪几帧之后读回（1 起）；缺省只读最后一帧。 */
  readAt?: number[];
  /** 读回的 fbo 名字（按读回那一帧开始时扮演的名字）；缺省这个 effect 的全部 fbo，`[]` 不读。 */
  fbos?: string[];
  /** 另外读回图层的合成 RT（基础 pass 画进去的那张，`composites[0]`）。 */
  composite?: boolean;
  /** 读回场景目标（场景分辨率）。 */
  scene?: boolean;
  /** 读回画布 `[宽, 高]`：按 `fill` 把场景目标铺进这么大的 `rgba8unorm` 纹理（同 `renderFrame` 的 `canvas`），PNG 另存一份。 */
  canvas?: [number, number];
  /** 结果的存放键前缀，缺省 `fluid-<时间>`。 */
  key?: string;
}

export interface FluidRead {
  /** fbo 名、`composite`、`scene` 或 `canvas`。 */
  name: string;
  width: number;
  height: number;
  /** 纹理格式；画布是 `rgba8unorm`。 */
  format: string;
  channels: number;
  /** 存的数据：`float32`（半精度格式转的）或 `uint8`（`rgba8unorm` 原样）。 */
  dtype: "float32" | "uint8";
  /** `chunk` 取数据的键；画布另有 `<键>.png`。 */
  key: string;
  bytes: number;
  /** 各通道的均值、最小、最大（`uint8` 按 0–255）。 */
  mean: number[];
  min: number[];
  max: number[];
}

export interface FluidProbeResult {
  object: number;
  effect: number;
  sceneSize: [number, number];
  sceneFormat: string;
  unsupported: string[];
  /** effect 的 fbo：名字、尺寸、格式（建好场景时）。 */
  fbos: { name: string; width: number; height: number; format: string }[];
  injected: { name: string; file: string; width: number; height: number; format: string }[];
  /** 每个读回的帧：帧号、这一帧的输入、这一帧开始时每个名字对应的初始实体（名字 → 第 1 帧开始时扮演它的名字），以及读回的数据。 */
  reads: { frame: number; input: Required<FluidFrame>; roles: Record<string, string>; items: FluidRead[] }[];
  key: string;
  ms: number;
}

/** 读回的纹理格式：每纹素字节数、通道数、是不是半精度。 */
export const READ_FORMATS: Readonly<Record<string, { bytes: number; channels: number; half: boolean }>> = {
  r16float: { bytes: 2, channels: 1, half: true },
  rg16float: { bytes: 4, channels: 2, half: true },
  rgba16float: { bytes: 8, channels: 4, half: true },
  rgba8unorm: { bytes: 4, channels: 4, half: false },
  rg8unorm: { bytes: 2, channels: 2, half: false },
  r8unorm: { bytes: 1, channels: 1, half: false },
};

/** 一帧真正用到的输入（指针补齐、cursor 按窗口换算）。 */
export interface PlannedFrame {
  frametime: number;
  time: number;
  pointer: Point;
  pointerLast: Point;
  cursor: Point;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isPoint = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every(finite);

/**
 * 校验并补齐逐帧输入（纯函数，单测）：`frametime` 非负、`time` 有限；`pointer` 缺省沿用上一帧（第 1 帧 `[0.5, 0.5]`），
 * `pointerLast` 缺省上一帧的 `pointer`（第 1 帧为自己）；`g_PointerPosition` 原样进 uniform（窗口坐标），控制点的 cursor
 * 按 `window` 用 `fill` 换到场景上（同 `renderFrame`，窗口没给或与场景同尺寸时原样）。`readAt` 缺省最后一帧，要在 1…帧数之间。
 */
export function planFluidFrames(
  frames: readonly FluidFrame[],
  scene: readonly [number, number],
  window?: readonly [number, number],
  readAt?: readonly number[],
): { frames: PlannedFrame[]; readAt: Set<number> } {
  if (!Array.isArray(frames) || !frames.length) throw new Error("frames 至少要有一帧");
  const convert = windowPointer(scene, window);
  let previous: Point | null = null;
  const planned = frames.map((frame, i) => {
    if (!finite(frame?.frametime) || frame.frametime < 0) throw new Error(`frames[${i}].frametime 要是非负数`);
    if (!finite(frame.time)) throw new Error(`frames[${i}].time 要是有限数`);
    for (const field of ["pointer", "pointerLast"] as const)
      if (frame[field] !== undefined && !isPoint(frame[field]))
        throw new Error(`frames[${i}].${field} 要是 [x, y]（两个有限数）`);
    const raw: Point = frame.pointer ? [frame.pointer[0], frame.pointer[1]] : (previous ?? [0.5, 0.5]);
    const rawLast: Point = frame.pointerLast ? [frame.pointerLast[0], frame.pointerLast[1]] : (previous ?? raw);
    previous = raw;
    const now = convert(raw);
    return {
      frametime: frame.frametime,
      time: frame.time,
      pointer: now.pointer,
      pointerLast: convert(rawLast).pointer,
      cursor: now.cursor,
    };
  });
  const wanted = readAt?.length ? readAt : [frames.length];
  for (const n of wanted)
    if (!Number.isInteger(n) || n < 1 || n > frames.length) throw new Error(`readAt 里的 ${n} 不在 1…${frames.length}`);
  return { frames: planned, readAt: new Set(wanted) };
}

/**
 * 名字 → 此刻扮演它的是第 1 帧开始时哪个名字的实体（纯函数，单测）：`swap` 偶数次后各自对应自己，奇数次后两两互换。
 * 找不到的（不该发生）记作 `?`。
 */
export function fboRoles<T>(current: ReadonlyMap<string, T>, initial: ReadonlyMap<string, T>): Record<string, string> {
  const byEntity = new Map<T, string>();
  for (const [name, entity] of initial) byEntity.set(entity, name);
  return Object.fromEntries([...current].map(([name, entity]) => [name, byEntity.get(entity) ?? "?"]));
}

/**
 * 把 `copyTextureToBuffer` 的结果（每行按 256 字节对齐）去掉行尾填充，半精度转 float32（纯函数，单测）。
 */
export function decodeReadback(
  raw: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
  format: string,
): Float32Array | Uint8Array {
  const spec = READ_FORMATS[format];
  if (!spec) throw new Error(`读回不支持格式 ${format}`);
  const row = width * spec.bytes;
  const packed = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) packed.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + row), y * row);
  if (!spec.half) return packed;
  const halves = new Uint16Array(packed.buffer);
  const out = new Float32Array(halves.length);
  for (let i = 0; i < halves.length; i++) out[i] = halfBitsToFloat(halves[i]);
  return out;
}

/** 各通道的均值、最小、最大。 */
export function channelStats(
  data: ArrayLike<number>,
  channels: number,
): { mean: number[]; min: number[]; max: number[] } {
  const sum = new Array<number>(channels).fill(0);
  const min = new Array<number>(channels).fill(Infinity);
  const max = new Array<number>(channels).fill(-Infinity);
  for (let i = 0; i < data.length; i++) {
    const c = i % channels;
    const v = data[i];
    sum[c] += v;
    if (v < min[c]) min[c] = v;
    if (v > max[c]) max[c] = v;
  }
  const count = data.length / channels;
  return { mean: sum.map((s) => s / count), min, max };
}

/** 在调用方的编码器里排一次纹理读回，提交后 `await` 返回的函数取数据。 */
function scheduleRead(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  texture: GPUTexture,
  width: number,
  height: number,
  format: string,
): () => Promise<Float32Array | Uint8Array> {
  const spec = READ_FORMATS[format];
  if (!spec) throw new Error(`读回不支持格式 ${format}`);
  const bytesPerRow = Math.ceil((width * spec.bytes) / 256) * 256;
  const buffer = device.createBuffer({
    label: "fluid probe readback",
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width, height });
  return async () => {
    await buffer.mapAsync(GPUMapMode.READ);
    const data = decodeReadback(new Uint8Array(buffer.getMappedRange()), width, height, bytesPerRow, format);
    buffer.unmap();
    buffer.destroy();
    return data;
  };
}

/** 读回画布：同 `probe.ts` 的 `encodeCanvasBlit`（产品上屏的着色器与采样器，按 `fill` 铺满），`encode` 之后调。 */
function encodeCanvas(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  scene: GpuScene,
  [width, height]: readonly [number, number],
): { texture: GPUTexture; release: () => void } {
  const texture = device.createTexture({
    label: "fluid probe canvas",
    size: [width, height],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const placement = scenePlacement("fill", scene.width, scene.height, width, height);
  const placementBuffer = device.createBuffer({
    label: "fluid probe canvas placement",
    size: PLACEMENT_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(placementBuffer, 0, placementUniform(placement));
  const pipeline = createBlitPipeline(device, "rgba8unorm");
  const bindGroup = createBlitBindGroup(
    device,
    pipeline,
    placementBuffer,
    scene.targetView!,
    device.createSampler(BLIT_SAMPLER),
  );
  encodeBlit(encoder, texture.createView(), [0, 0, 0], placement.rect, pipeline, bindGroup);
  return {
    texture,
    release: () => {
      texture.destroy();
      placementBuffer.destroy();
    },
  };
}

async function encodePngRgba(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const pixels = new Uint8ClampedArray(rgba);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.putImageData(new ImageData(pixels, width, height), 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

export async function fluidProbe(options: FluidProbeOptions): Promise<FluidProbeResult> {
  const started = performance.now();
  const canvas = options.canvas === undefined ? undefined : checkCanvas(options.canvas);
  const key = options.key ?? `fluid-${Date.now()}`;
  const effectIndex = options.effect ?? 0;
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
  const gpu = await acquireGpu();
  const device = gpu.device;
  try {
    if (canvas) checkCanvas(canvas, device.limits.maxTextureDimension2D);
    const { width: sceneWidth, height: sceneHeight } = bundle.general;
    const { frames, readAt } = planFluidFrames(
      options.frames,
      [sceneWidth, sceneHeight],
      options.window ?? canvas,
      options.readAt,
    );
    const object = options.object ?? bundle.layers.find((layer) => layer.effects.length)?.object;
    if (object === undefined) throw new Error("场景里没有带 effect 的图层");
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(device, bundle, state, gpu.features, [], {
      ignoreUnsupported: force,
      particles: { seed: 1, passes: 1, cursor: frames[0].cursor },
    });
    try {
      const targetsNow = () => {
        const targets = scene.devLayerTargets(object, effectIndex);
        if (!targets) throw new Error(`图层 ${object} 没有第 ${effectIndex} 个 effect（或没建资源）`);
        return targets;
      };
      const initial = targetsNow();
      const initialTextures = new Map([...initial.fbos].map(([name, target]) => [name, target.texture]));
      // 输入：按此刻（第 1 帧开始时）扮演这个名字的实体写
      const injected: FluidProbeResult["injected"] = [];
      for (const item of options.inject ?? []) {
        const target = initial.fbos.get(item.name);
        if (!target) throw new Error(`effect 里没有 fbo ${item.name}（有 ${[...initial.fbos.keys()].join("、")}）`);
        const response = await fetch(fileToUrl(item.file));
        if (!response.ok) throw new Error(`读不到 ${item.file}（${response.status}）`);
        const image = parseDds(new Uint8Array(await response.arrayBuffer()), item.file);
        if (image.format !== target.format || image.width !== target.width || image.height !== target.height)
          throw new Error(
            `${item.file} 是 ${image.width}×${image.height} ${image.format}，fbo ${item.name} 是 ${target.width}×${target.height} ${target.format}`,
          );
        device.queue.writeTexture(
          { texture: target.texture },
          image.data,
          { bytesPerRow: image.width * image.bytesPerTexel },
          { width: image.width, height: image.height },
        );
        injected.push({
          name: item.name,
          file: item.file,
          width: image.width,
          height: image.height,
          format: image.format,
        });
      }
      const wantedFbos = options.fbos ?? [...initial.fbos.keys()];
      for (const name of wantedFbos) if (!initial.fbos.has(name)) throw new Error(`effect 里没有 fbo ${name}`);

      let parallax = initialParallaxState(sceneWidth, sceneHeight);
      const reads: FluidProbeResult["reads"] = [];
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const number = i + 1;
        // 顺序同渲染器与 renderFrame 的 profile 帧：视差点带本帧抖动推进 → sync → 粒子用上一帧的相机步进 → 设本帧相机 → 视差 → uniform
        const shake = shakeOffset(state.general, frame.time, sceneHeight);
        parallax = advanceParallax(
          parallax,
          parallaxInput(state.general, {
            pointer: frame.pointer,
            frametime: frame.frametime,
            width: sceneWidth,
            height: sceneHeight,
            eye: shake,
          }),
        );
        scene.sync(state);
        scene.stepParticles(frame.frametime, frame.time, state, frame.cursor);
        scene.setCamera({ shake, zoom: state.general.zoom });
        scene.setParallax(drawParallax(parallax, state.general), state);
        scene.update(
          {
            time: frame.time,
            frametime: frame.frametime,
            daytime: 0.5,
            pointer: frame.pointer,
            pointerLast: frame.pointerLast,
            cursor: frame.cursor,
            parallax: parallax.position,
          },
          state,
        );
        const read = readAt.has(number);
        // 读回按这一帧开始时（swap 之前）扮演各名字的实体取
        const before = read ? targetsNow() : null;
        const encoder = device.createCommandEncoder({ label: `fluid probe frame ${number}` });
        scene.encode(encoder, state);
        if (!before) {
          device.queue.submit([encoder.finish()]);
          continue;
        }
        const pending: {
          name: string;
          width: number;
          height: number;
          format: string;
          take: () => Promise<Float32Array | Uint8Array>;
        }[] = [];
        for (const name of wantedFbos) {
          const target = before.fbos.get(name)!;
          pending.push({
            name,
            width: target.width,
            height: target.height,
            format: target.format,
            take: scheduleRead(device, encoder, target.texture, target.width, target.height, target.format),
          });
        }
        if (options.composite) {
          const target = before.composites[0];
          if (!target) throw new Error(`图层 ${object} 没有合成 RT`);
          pending.push({
            name: "composite",
            width: target.width,
            height: target.height,
            format: target.format,
            take: scheduleRead(device, encoder, target.texture, target.width, target.height, target.format),
          });
        }
        if (options.scene) {
          const texture = scene.targetTexture!;
          pending.push({
            name: "scene",
            width: scene.width,
            height: scene.height,
            format: texture.format,
            take: scheduleRead(device, encoder, texture, scene.width, scene.height, texture.format),
          });
        }
        let release: (() => void) | null = null;
        if (canvas) {
          device.pushErrorScope("validation");
          const blit = encodeCanvas(device, encoder, scene, canvas);
          release = blit.release;
          pending.push({
            name: "canvas",
            width: canvas[0],
            height: canvas[1],
            format: "rgba8unorm",
            take: scheduleRead(device, encoder, blit.texture, canvas[0], canvas[1], "rgba8unorm"),
          });
        }
        device.queue.submit([encoder.finish()]);
        if (canvas) {
          const error = await device.popErrorScope();
          if (error) throw new Error(`读回画布时 WebGPU 校验出错：${error.message}`);
        }
        const items: FluidRead[] = [];
        try {
          for (const item of pending) {
            const data = await item.take();
            const channels = READ_FORMATS[item.format].channels;
            const dtype = data instanceof Float32Array ? "float32" : "uint8";
            const storeKey = `${key}-f${number}-${item.name}.${dtype === "float32" ? "f32" : "u8"}`;
            const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            storeProbeBytes(storeKey, bytes);
            if (item.name === "canvas")
              storeProbeBytes(`${key}-f${number}-canvas.png`, await encodePngRgba(bytes, item.width, item.height));
            items.push({
              name: item.name,
              width: item.width,
              height: item.height,
              format: item.format,
              channels,
              dtype,
              key: storeKey,
              bytes: bytes.length,
              ...channelStats(data, channels),
            });
          }
        } finally {
          release?.();
        }
        reads.push({
          frame: number,
          input: {
            frametime: frame.frametime,
            time: frame.time,
            pointer: frame.pointer,
            pointerLast: frame.pointerLast,
          },
          roles: fboRoles(new Map([...before.fbos].map(([name, target]) => [name, target.texture])), initialTextures),
          items,
        });
      }
      return {
        object,
        effect: effectIndex,
        sceneSize: [scene.width, scene.height],
        sceneFormat: scene.targetTexture?.format ?? scene.format,
        unsupported: bundle.unsupported,
        fbos: [...initial.fbos].map(([name, target]) => ({
          name,
          width: target.width,
          height: target.height,
          format: target.format,
        })),
        injected,
        reads,
        key,
        ms: Math.round(performance.now() - started),
      };
    } finally {
      scene.destroy();
    }
  } finally {
    for (const texture of bundle.textures) for (const mip of texture.mips) mip.bitmap?.close();
    cache.clear();
    device.destroy();
  }
}
