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
 * - 视差（P5a 步骤 2）：`renderFrame`、`hostRenderFrame` 与 `particleCorners` 都从加载时的状态（场景中心）起逐帧推进视差点，用同一套
 *   `render/parallax.ts`，读回的那一帧把 P 交给 `GpuScene.setParallax`、`g_ParallaxPosition` 进帧输入。
 * - 逐帧光标（P5a 收尾）：`renderFrame`、`particleCorners` 收 `pointers`（每帧的 `g_PointerPosition`）与 `window`（抓帧窗口尺寸），
 *   `particleTrack` 收 `cursors` 与 `window`；窗口坐标按壁纸样式 `fill` 推出控制点的 cursor（`replayPointers.ts`），回放到读回帧的
 *   顺序由 `particleCorners.ts` 的 `replayReadback` 统一。不给这些字段时三者逐字节同以前。
 * - 抖动（P5a 步骤 3）：三者每一帧按这一帧的 `g_Time` 算 s（`render/shake.ts`），粒子先用上一帧的 s 步进、之后才交给
 *   `GpuScene.setCamera`（同渲染器与 WPE），视差点带同一帧的 s 推进；读回的那一帧先 `setCamera` 再 `setParallax`，矩阵与眼位跟着变。
 * - 缩放（P5a 步骤 4）：`general.zoom` 随 s 一起交给 `setCamera`（`frameCamera`），取当时的 `state.general.zoom`；`particleTrack` 的
 *   跟随点同样按带缩放的投影反投影。
 * - 读回画布（kabegame-chromium 第 5 批）：`renderFrame` 收 `canvas: [宽, 高]` 时，读回那一帧编码完场景之后，用产品上屏的同一份
 *   着色器与采样器（`render/blit.ts`）按 `fill` 把场景目标铺进这么大的 `rgba8unorm` 纹理、读回它；光标的换算窗口是 `window ?? canvas`。
 *   只改读回、不改渲染（`g_Screen` 等仍按场景目标算）。不给 `canvas` 时读回场景目标，逐字节同以前。
 * - 脚本值（kabegame-chromium 第 6 批）：探针不跑场景脚本，`renderFrame` 收 `scriptValues`（某对象某字段的字段脚本在读回那一帧返回的
 *   值），建好场景之后、回放之前经字段脚本的绑定目标写进 `SceneState`（`scriptValues.ts`，同宿主的脚本写回）。不给时逐字节同以前。
 *
 * 读回一律在提交本帧的同一任务里排 `copyTextureToBuffer`，不经过页面上的画布（画布要在同一任务内同步取，否则是全透明空图）。
 */
import type { SceneBundle } from "../compile/bundle";
import { compileSceneInWorker } from "../compile/client";
import { TextureDecodeCache } from "../compile/decode";
import { FetchSceneReader } from "../compile/fs";
import type { ScenePostprocessSetting } from "../compile/postprocess";
import { particleTrack, type ParticleTrack } from "../particles/track";
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
import { GpuScene, type ParticleProfile } from "../render/scene";
import { shakeOffset } from "../render/shake";
import { SceneState } from "../render/state";
import type { SceneHost } from "../host";
import { replayParticleOptions, replayReadback, type ParticleReplay } from "./particleCorners";
import { checkCanvas, pointerWindow, replayPointers, sceneCursors } from "./replayPointers";
import { applyScriptValues, type ScriptValue, type ScriptValueResult } from "./scriptValues";

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
  /** `g_Time`（秒）；`g_Daytime` 固定 0.5，保证可复现。传了 `particles` 时改用 dt 的累计值。 */
  time?: number;
  /**
   * `g_PointerPosition` 与 `g_PointerPositionLast`（窗口归一化坐标，原样进 uniform），缺省在中心 `[0.5, 0.5]`。
   * 和 WPE 抓帧比时填抓帧里读到的值（P4b 步骤 1：`2854083091` 的 x 光随指针）。同一个值也推出控制点跟随指针的 `cursor`
   * （光标下的场景纹理坐标，P4c 步骤 2；没给 `window` 或窗口和场景同尺寸时两者相同），加载时的预热、回放的每一帧和读回那一帧都用它。
   * 视差点（P5a 步骤 2）同样用它从加载起逐帧推进。抓帧期间光标在动时改给 `pointers`。
   */
  pointer?: [number, number];
  /**
   * 逐帧的 `g_PointerPosition`（P5a 收尾：回放逐帧光标），和 `particles.dts` 等长（第 i 项是第 i + 1 帧），要有 `particles`，
   * 不和 `pointer` 同给。第 i 帧步进粒子用第 i 项推出的 cursor、视差点用第 i 项；预热用第 0 项；读回那一帧的 `g_PointerPosition` 是最后
   * 一项、`g_PointerPositionLast` 是倒数第二项（只有一帧时取自己）；`profile` 帧用第 0 项。
   */
  pointers?: [number, number][];
  /**
   * 抓帧窗口尺寸 `[宽, 高]`（像素）：和场景不同尺寸时，光标（`pointer` / `pointers`）按壁纸样式 `fill` 换到场景上推出 cursor
   * （`sceneCursor`，同渲染器与 kbp replay），`g_PointerPosition` 仍是窗口坐标；缺省或同尺寸时原样。没给时取 `canvas`；两个都给
   * 而不相等时抛错（`pointerWindow`）。
   */
  window?: [number, number];
  /**
   * 读回画布尺寸 `[宽, 高]`（像素，两个正整数，各不超过设备的 `maxTextureDimension2D`，否则抛错）：读回那一帧编码完场景之后，用产品
   * 上屏的同一份着色器与线性采样器（`render/blit.ts`），按 `fill`（`scenePlacement("fill", …)`，居中盖满裁切，同 WPE 测试窗口）把
   * 场景目标铺进这么大的 `rgba8unorm` 纹理（留白色黑，`fill` 没有留白），读回它；PNG 与 `.rgba` 都是画布尺寸。画布就是模拟的壁纸
   * 窗口，没给 `window` 时光标按它换算。只改读回、不改渲染：内置 uniform（`g_Screen`、`g_TexelSize`）仍按场景目标算，同产品。
   * 不给时读回场景目标，逐字节同以前。
   */
  canvas?: [number, number];
  /** 结果的存放键；PNG 存 `<key>.png`，原始 RGBA（读回的尺寸，alpha 置 255）存 `<key>.rgba`。 */
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
   * 建场景（含预热）后按 `dts` 步进，`dts[0]` 是第 1 帧，最后一帧就是读回的那一帧，`g_Time` 取 `times`（P4b 步骤 4，和 WPE
   * 比时填日志的 `runtime` 列），没给时用 dt 的累计值；粒子的场景时间 `T` 与它同一个值。
   * 不传时种子同样固定为 1、不步进，画的是预热后的状态。
   * `random`（P4b 步骤 2）：`{ <objects 下标>: [R, …] }`，按出生顺序顶替该系统的 `R`，用完退回种子随机数；`randomframe`
   * 系统和 WPE 比像素时填 WPE 轨迹里的 frame。
   */
  particles?: ParticleReplay;
  /**
   * 脚本值（kabegame-chromium 第 6 批）：`{ object: objects 下标或对象名, field: 图层字段, value: 1–4 个数或布尔, optional? }[]`，
   * 某个对象某个字段上的字段脚本在读回那一帧会返回的值。探针找到 bundle 里挂在这个字段上的字段脚本，建好场景之后、回放之前用它的
   * 绑定目标经 `SceneState.write` 写进状态（同宿主的脚本写回）；值不影响模拟，只有读回那一帧被画出来。名字重名抛错；找不到对象或
   * 没挂字段脚本时 `optional` 的跳过，否则抛错。用途：kbp 测试工程的 FR 帧号块（颜色只取决于帧号），见 `scriptValues.ts`。
   */
  scriptValues?: ScriptValue[];
}

export interface RenderFrameResult {
  /** 读回图片的尺寸：给了 `canvas` 时是画布，否则是场景目标。 */
  width: number;
  height: number;
  /** 读回的画布 `[宽, 高]`；没给 `canvas`（读回场景目标）时为 null。 */
  canvas: [number, number] | null;
  /** 场景目标（离屏渲染目标）的尺寸：场景分辨率，超过设备上限时等比缩小。 */
  sceneTarget: [number, number];
  /** 场景目标的格式（`rgba16float` 是 HDR 场景）；读回的画布总是 `rgba8unorm`。 */
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
  /** 每一项脚本值写没写进状态（`applied`；跳过时带 `reason`），顺序同请求；没给 `scriptValues` 时空数组。 */
  scriptValues: ScriptValueResult[];
  /** PNG 的存放键是 `<key>.png`，原始 RGBA 是 `<key>.rgba`，都用 `chunk` 取（base64 分块）。 */
  key: string;
}

/**
 * 读回画布（第 5 批）：在 `scene.encode` 之后、同一个编码器里，用产品上屏的同一份着色器与采样器参数（`render/blit.ts`）按 `fill`
 * 把这一帧的场景目标铺进 `canvas` 尺寸的 `rgba8unorm` 纹理。铺放按场景目标尺寸算，同渲染器的 `syncPlacement`；留白色黑（`fill`
 * 盖满，没有留白）。返回画布纹理，以及读回之后释放资源的函数。
 */
function encodeCanvasBlit(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  scene: GpuScene,
  [width, height]: readonly [number, number],
): { texture: GPUTexture; release: () => void } {
  const texture = device.createTexture({
    label: "probe canvas",
    size: [width, height],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const placement = scenePlacement("fill", scene.width, scene.height, width, height);
  const placementBuffer = device.createBuffer({
    label: "probe canvas placement",
    size: PLACEMENT_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(placementBuffer, 0, placementUniform(placement));
  const pipeline = createBlitPipeline(device, "rgba8unorm");
  // `encode` 之后取：有两张目标时它开头才换，铺进画布的必须是这一帧画的那张（同渲染器）
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

/**
 * 编译并按固定时刻渲染一帧，读回离屏场景目标（不经过页面上的画布、不做铺放）；给了 `canvas` 时读回按 `fill` 上屏到这么大的画布
 * （`encodeCanvasBlit`）。
 */
export async function renderFrame(options: RenderFrameOptions): Promise<RenderFrameResult> {
  // 先查读回画布与光标窗口（`window ?? canvas`，两个都给而不同时抛错），参数错时不编译；纹理上限要等取到设备再查
  const canvas = options.canvas === undefined ? undefined : checkCanvas(options.canvas);
  const cursorWindow = pointerWindow(options.window, canvas);
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
    if (canvas) checkCanvas(canvas, gpu.device.limits.maxTextureDimension2D);
    const state = SceneState.fromBundle(bundle);
    const { width: sceneWidth, height: sceneHeight } = bundle.general;
    // 每一帧的 g_PointerPosition 与 cursor（P5a 收尾）：只给 pointer（或都不给）时每帧相同，同加逐帧指针之前。
    // 换算窗口是 `window ?? canvas`（第 5 批）：读回画布就是模拟的壁纸窗口
    const pointers = replayPointers(
      { pointer: options.pointer, pointers: options.pointers, window: cursorWindow },
      [sceneWidth, sceneHeight],
      options.particles?.dts.length,
    );
    const scene = await GpuScene.build(gpu.device, bundle, state, gpu.features, [], {
      ignoreUnsupported: force,
      particles: { ...replayParticleOptions(options.particles), cursor: pointers.warmup },
    });
    // 视差（P5a 步骤 2）：从加载时的场景中心起，每一帧（profile 帧、回放帧、读回帧）按它的帧时间推进一次，同渲染器；profile 帧用第 0 项的指针
    const pointer = pointers.pointers[0];
    const cursor = pointers.cursors[0];
    const parallaxFrame = { pointer, width: sceneWidth, height: sceneHeight };
    let parallax = initialParallaxState(sceneWidth, sceneHeight);
    try {
      // 脚本值（第 6 批）：建好场景之后、回放之前写进状态，同宿主的脚本写回；第一次 `sync` 把它刷进 uniform
      const scriptValues = applyScriptValues(state, bundle, options.scriptValues);
      const startTime = options.time ?? 0;
      let frameMs: RenderFrameResult["frameMs"];
      let particleMs: RenderFrameResult["particleMs"];
      if (options.profile) {
        // 只记 profile 帧：读回那一帧之前取走并关掉
        scene.profileParticles(true);
        const samples: number[] = [];
        for (let i = 0; i < options.profile; i++) {
          const t0 = performance.now();
          // 顺序同渲染器（P4c 步骤 4）：先步进粒子再写 uniform；探针没有脚本，两次 sync 之间没有改动，省掉第二次。
          // 没有脚本，视差在步进之后、update 之前交给场景，结果同渲染器。抖动（P5a 步骤 3）：视差点带这一帧的 s，粒子先用上一帧的
          // s 步进，之后才设这一帧的（同渲染器）；缩放随同一个相机（步骤 4）
          const shake = shakeOffset(state.general, startTime + i / 60, sceneHeight);
          parallax = advanceParallax(
            parallax,
            parallaxInput(state.general, { ...parallaxFrame, frametime: 1 / 60, eye: shake }),
          );
          scene.sync(state);
          scene.stepParticles(1 / 60, startTime + i / 60, state, cursor);
          scene.setCamera({ shake, zoom: state.general.zoom });
          scene.setParallax(drawParallax(parallax, state.general), state);
          scene.update(
            {
              time: startTime + i / 60,
              frametime: 1 / 60,
              daytime: 0.5,
              pointer,
              pointerLast: pointer,
              cursor,
              parallax: parallax.position,
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
      // 粒子回放：前 n−1 帧在 replayParticles 里步进，最后一帧先步进再写 uniform（顺序同渲染器，P4c 步骤 4）。
      // 抖动与缩放（P5a 步骤 3、4）：每一帧先用上一帧的相机步进粒子、再设这一帧的（同渲染器），读回的那一帧同样，之后才 setParallax。
      // 视差点从 profile 帧推进后的状态接着走；逐帧指针（P5a 收尾）第 i 帧用第 i 项，读回帧的 g_PointerPositionLast 是上一帧的
      const { time, frametime } = replayReadback(scene, state, {
        particles: options.particles,
        time: startTime,
        pointers,
        parallax,
        size: [sceneWidth, sceneHeight],
      });
      const encoder = gpu.device.createCommandEncoder({ label: "probe frame" });
      scene.encode(encoder, state);
      const format = scene.targetTexture!.format as ReadbackFormat;
      let raw: Uint8Array | Float32Array;
      if (canvas) {
        // 读回画布（第 5 批）：场景之后在同一个编码器里按 fill 上屏到画布纹理再读回。校验错误（比如管线建不出来）不静默读回空图
        gpu.device.pushErrorScope("validation");
        const blit = encodeCanvasBlit(gpu.device, encoder, scene, canvas);
        try {
          const read = scheduleReadback(gpu.device, encoder, blit.texture, canvas[0], canvas[1], "rgba8unorm");
          gpu.device.queue.submit([encoder.finish()]);
          const error = await gpu.device.popErrorScope();
          if (error) throw new Error(`读回画布时 WebGPU 校验出错：${error.message}`);
          raw = await read();
        } finally {
          blit.release();
        }
      } else {
        const read = scheduleReadback(gpu.device, encoder, scene.targetTexture!, scene.width, scene.height, format);
        gpu.device.queue.submit([encoder.finish()]);
        raw = await read();
      }
      const [width, height] = canvas ?? [scene.width, scene.height];
      const rgba = raw instanceof Uint8Array ? raw : quantize8(raw);
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
      const key = options.key ?? `frame-${Date.now()}`;
      storeProbeBytes(`${key}.png`, await encodePng(rgba, width, height));
      storeProbeBytes(`${key}.rgba`, rgba);
      const sums = [0, 0, 0];
      for (let i = 0; i < rgba.length; i += 4) {
        sums[0] += rgba[i];
        sums[1] += rgba[i + 1];
        sums[2] += rgba[i + 2];
      }
      const count = rgba.length / 4;
      return {
        width,
        height,
        canvas: canvas ? [canvas[0], canvas[1]] : null,
        sceneTarget: [scene.width, scene.height],
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
        scriptValues,
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
 * 是「就地 = 重编译」的真机判据（P3a 验收 4）。指针固定在 (0.5, 0.5)；视差同 `renderFrame`，从加载时的场景中心起推进这一帧
 * （帧时间 0），不用渲染器正在用的视差点；抖动按 `time` 现算（P5a 步骤 3），缩放取当前状态的 `general.zoom`（步骤 4）。交给场景的
 * 视差与相机留在当前场景上，渲染器的下一帧照常换回自己的。
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
  // 视差点的单位是场景的正交尺寸（`bundle.general`），没有 bundle 时退回场景目标尺寸
  const { width, height } = host.devScene.bundle?.general ?? scene;
  const shake = shakeOffset(state.general, time, height);
  scene.setCamera({ shake, zoom: state.general.zoom });
  const parallax = advanceParallax(
    initialParallaxState(width, height),
    parallaxInput(state.general, { pointer: [0.5, 0.5], frametime: 0, width, height, eye: shake }),
  );
  scene.setParallax(drawParallax(parallax, state.general), state);
  scene.sync(state);
  // 帧时间 0：粒子不步进，读回的是当前状态（`stepParticles` 只记下 cursor，同以前 `update` 里的那一步）
  scene.stepParticles(0, time, state, [0.5, 0.5]);
  scene.update(
    {
      time,
      frametime: 0,
      daytime: 0.5,
      pointer: [0.5, 0.5],
      pointerLast: [0.5, 0.5],
      cursor: [0.5, 0.5],
      parallax: parallax.position,
    },
    state,
  );
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
  /** 每帧的 `g_Time`（噪声类模块的场景时间 `T`，P4b 步骤 4），和 `dts` 等长；不给时按 `dts` 累加。 */
  times?: number[];
  /** 要输出的帧号。 */
  frames: number[];
  /** operator 遍数：WPE 设置 `fps` 在 1–20 时两遍，否则一遍。 */
  passes: 1 | 2;
  seed?: number;
  /** 按 `objects` 下标、按出生顺序顶替 `R`，同 `renderFrame` 的 `particles.random`。 */
  random?: Record<number, number[]>;
  /**
   * 每帧的 `g_PointerPosition`（抓帧窗口归一化坐标，P4c 步骤 2；P5a 收尾起不再要调用方换算），和 `dts` 等长；第 1 项也用于预热。
   * 探针按 `window` 换成光标下的场景纹理坐标再交给 `particles/track.ts` 的 `cursors`。不给时是场景中心。
   */
  cursors?: [number, number][];
  /**
   * 抓帧窗口尺寸 `[宽, 高]`（像素）：和场景不同尺寸时 `cursors` 按壁纸样式 `fill` 换到场景上（`sceneCursor`，同 `renderFrame` 与
   * kbp replay）；缺省或同尺寸时原样。
   */
  window?: [number, number];
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
    const size: [number, number] = [bundle.general.width, bundle.general.height];
    return particleTrack({
      layers: bundle.layers,
      dts: options.dts,
      times: options.times,
      frames: options.frames,
      passes: options.passes,
      seed: options.seed,
      random: options.random,
      // 窗口归一化 → 光标下的场景纹理坐标（P5a 收尾，换算放在 dev 里，`particles/track.ts` 只收场景坐标）
      cursors: options.cursors && sceneCursors(options.cursors, size, options.window),
      size,
      // 跟随点按上一帧的抖动反投影（P5a 步骤 3），投影带缩放（步骤 4），同渲染器
      shake: bundle.general.fields,
      zoom: bundle.general.fields.zoom,
      project: options.projectDir.split(/[\\/]/).filter(Boolean).at(-1) ?? "",
      tag: options.tag,
    });
  } finally {
    for (const texture of bundle.textures) for (const mip of texture.mips) mip.bitmap?.close();
  }
}
