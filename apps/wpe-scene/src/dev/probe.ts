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
 * - 按指定尺寸画（phase-render-size）：正交场景给了 `canvas: [宽, 高]`（且没给 `renderMode: "scene"`）时，场景目标就是 `canvas`，壁纸样式
 *   `style`（缺省 fill，tile 不收）照 WPE 的对齐方式做进正交投影的四个裁切边距（`alignEdges`），对齐方式 1 / 3 的清屏色是 `schemecolor`；
 *   读回场景目标本身，不再经上屏铺放；`g_Screen`、快照、泛光、反射、深度、fullscreen 合成 RT 随目标走，视差、`g_EyePosition`、抖动是场景单位。
 *   光标按窗口坐标：`g_PointerPosition` 原样，控制点跟随点与光标命中按裁切后的 VP 反投影窗口坐标，视差的指针是窗口归一化坐标 × 场景尺寸。
 *   决定在 `renderTarget.ts`，结果的 `render` 说明这次的画法。
 * - 读回画布（kabegame-chromium 第 5 批，现为 `renderMode: "scene"`）：`renderFrame` 收 `canvas: [宽, 高]` 且 `renderMode: "scene"` 时，读回那一帧
 *   编码完场景之后，用产品上屏的同一份着色器与采样器（`render/blit.ts`）按 `fill` 把场景目标铺进这么大的 `rgba8unorm` 纹理、读回它；
 *   光标的换算窗口是 `window ?? canvas`。只改读回、不改渲染（`g_Screen` 等仍按场景目标算）。不给 `canvas` 时读回场景目标，逐字节同以前。
 * - 透视相机（P5d 步骤 2）：透视场景按画布尺寸渲染，场景目标取 `canvas ?? window ?? [1920, 1080]`；回放按 `particles.dts` 推路径
 *   状态（同渲染器，没给 dts 时 t = 0），读回的那一帧按推到那时的状态求相机，抖动按它的 `g_Time`（`times` 的最后一项）；视差点
 *   W = H = 0、不移动对象（`particleCorners.ts` 的 `frameCamera` / `replayReadback`）。`hostRenderFrame` 按路径起点求相机。
 * - 脚本值（kabegame-chromium 第 6 批）：不跑场景脚本时，`renderFrame` 收 `scriptValues`（某对象某字段的字段脚本在读回那一帧返回的
 *   值），建好场景之后、回放之前经字段脚本的绑定目标写进 `SceneState`（`scriptValues.ts`，同宿主的脚本写回）。不给时逐字节同以前。
 *   P6b 1e-3 起也收文本层的运行中字段（`text` 给字符串等），写进之后回放之前结清重排（`probeTexts.ts` 的 `settle`：缺字体时等读完再排，
 *   探针没有帧外补画），结果的 `textSyncs` 是结清时 `sync` 的次数；没有文本值时不结清。
 * - 频谱（P4e 步骤 4）：`renderFrame` / `particleCorners` 的 `particles.audio` 与 `particleTrack` 的 `audio` 收逐帧 16 段左右
 *   （`{ left, right }`，抓帧里 CLK 读到的 `g_AudioSpectrum16Left/Right`），每帧步进之前原样写进粒子读的频谱（不经归一化，null 沿用前一帧）；
 *   `host.audio()` 另报宿主场景频谱归一化后的 16 段（`spectrum16`）。不给时频谱全 0。P11a 起每项还可带 32 / 64 段（`left32` …
 *   `right64`），读回那一帧的六个 `g_AudioSpectrum*` uniform 取截至这一帧最后一个非 null 项，没给的段为 0（`replayReadback`）。
 * - 视频时刻（P9a 步骤 3）：屏外宿主不跑帧循环、视频用自己的时钟，`renderFrame` 收 `videoTime`（秒，数字对全部视频纹理生效，
 *   `{ <纹理 path>: 秒 }` 分别给，没给的取 0，缺省 0）。探针换上自己的 `VideoSink`（`videoProbe.ts`）：每段视频 seek 到这个时刻
 *   （超过时长按循环取模）、等到当前帧可用，建好场景后、第一次编码之前交给 `GpuScene`，每个 draw 都拷；读不到或解码失败的视频照产品
 *   规则保持透明。结果的 `videos` 给出每段实际取的时刻。没有视频纹理的场景逐字节同以前。`hostRenderFrame` 不动视频，保持当前帧。
 * - 关键帧动画（P10a 步骤 3）：`renderFrame` 与 `particleCorners` 对有动画的 bundle 建 `SceneAnimations`（`animation/player.ts`）。有
 *   `particles.dts` 时沿同一串 dt 逐帧推进、写入（`replayReadback`，每帧在粒子与相机之后、第二次 `sync` 之前，同渲染器）；没有时按
 *   `time` 直接 `seek` 再写一次（近似，见 `SceneAnimations.seek`）。`profile` 帧另用一份按 1/60 推进，计时含动画开销，不影响读回那一帧。
 *   结果的 `animations` 给出每条最后写入的值；`host.animations()` 报宿主正在播的那份。没有动画的场景逐字节同以前。
 * - 回放的每一帧都画（P10a 走查，`ReadbackReplayOptions.encodeFrame`）：有 `particles.dts` 时前 n − 1 帧照读回帧的顺序写好 uniform、
 *   在 GPU 上编码提交，读回帧之前的跨帧状态（被依赖图层的合成 RT、`clearenabled: false` 的场景目标）同渲染器。只画读回帧时，排在
 *   前面的图层读到的被依赖 RT 是空的。没有回放（`time` 固定时刻）时仍只画一帧。
 * - 跑场景脚本（kabegame-chromium 第 7 批）：`renderFrame` 收 `scripts: true | { clock?, seed? }` 时，在探针自己的 `SceneState` 上照宿主
 *   搭脚本环境（`probeScripts.ts`：同一个 realm、`ScriptApi`、`ScriptRuntime`，写回同宿主），建好场景、视频就绪之后跑 `init` 并整份交一次
 *   用户属性；回放的每一帧（含读回帧，每帧都画时前 n − 1 帧也一样）在设好相机、推进完关键帧动画之后跑一帧脚本（`replayReadback` 的
 *   `scripts`，同渲染器 `beforeFrame` 里动画之后的位置），profile 帧不跑；每帧都画时每一帧的 `g_Daytime` 跟着脚本的时钟（只画读回帧时是
 *   读回帧）。`Date`、`Math.random`、`screenResolution`、`localStorage` 都来自请求或只在内存，两次同样的请求得到同一张图。读回之后结清
 *   文本重排（缺字体时等读完，重排过就再写一次这一帧的 uniform），再释放脚本环境。不和 `scriptValues` 同给。结果的 `scripts` 给出各段
 *   诊断、做不了的重编译写入、没接的 API 与实际用的时钟、种子。不给时逐字节同以前。
 * - 逐 draw 轨迹（`.claude/plans/tools/scene-draw-trace.md`）：`renderFrame` 收 `trace` 时，取到设备后建记录器
 *   （`render/trace.ts`），建场景、profile 帧、回放、读回帧（含读回画布）都用包过的设备；读回帧编码之前开始记，读回完成后取出
 *   轨迹与选中 pass 的读回图，存进存放区（`dev/drawTrace.ts`），结果的 `trace` 给键与摘要。不给 `trace` 时不建记录器、设备不包，
 *   逐字节同以前。
 *
 * 读回一律在提交本帧的同一任务里排 `copyTextureToBuffer`，不经过页面上的画布（画布要在同一任务内同步取，否则是全透明空图）。
 */
import { SceneAnimations, type AnimationProbeEntry } from "../animation/player";
import { puppetEntries, puppetEntry, ScenePuppets, stateSink } from "../puppet/player";
import type { SceneBundle } from "../compile/bundle";
import { DEFAULT_CAMERA } from "../compile/camera";
import { compileSceneInWorker, openSceneSession, type CompileSessionClient } from "../compile/client";
import type { FragmentDelta } from "../compile/fragment";
import { SceneRegistry, type RestructureResult } from "../compile/registry";
import { TextureDecodeCache } from "../compile/decode";
import { FragmentCache, fragmentKey } from "../fragmentCache";
import { cacheCopy, configBone, LiveObjects, rebindFragment, type LiveTarget } from "../script/createLayerChange";
import { trackGroupIssues } from "../script/structure";
import { SceneTexts } from "../text/host";
import { releaseTextLayout } from "../text/layout";
import { FetchSceneReader } from "../compile/fs";
import type {
  ScenePostprocessSetting,
  SceneReflectionSetting,
  SceneShadowSetting,
  SceneVolumetricsSetting,
} from "../compile/postprocess";
import { reflectionOverride } from "./reflectionOverride";
import { shadowsOverride } from "./shadowsOverride";
import { volumetricsOverride } from "./volumetricsOverride";
import { schemeColor } from "../sceneStyle";
import {
  checkRenderMode,
  checkRenderStyle,
  checkStyleUnused,
  otherRender,
  planSizedTarget,
  styleNeedsSchemeColor,
  wantsSizedTarget,
  type RenderDescription,
} from "./renderTarget";
import type { ParticleAudioFrame } from "../particles/audio";
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
import { fillCropEdges, scenePlacement } from "../render/layout";
import { cameraObjectLayers, initialCameraPathState, sceneCameraFrame } from "../render/camera";
import { advanceParallax, drawParallax, initialParallaxState, parallaxInput } from "../render/parallax";
import { GpuScene, type ParticleProfile, type PreparedObject } from "../render/scene";
import { textureAnimationOverride } from "../render/sheets";
import { spriteScale } from "../render/sprite";
import { SceneState } from "../render/state";
import type { UserTextureProbe } from "../usertex/sources";
import { createDrawTracer, type TraceOptions } from "../render/trace";
import type { SceneHost } from "../host";
import {
  frameCamera,
  probeCameraObjects,
  probePerspective,
  replayParticleOptions,
  replayReadback,
  type ParticleReplay,
} from "./particleCorners";
import { isTraceKey, traceArtifacts, traceOptionsOf, type RenderFrameTrace } from "./drawTrace";
import {
  createProbeScripts,
  probeDaytime,
  probeScriptsOptionsOf,
  readProbeUserProperties,
  type ProbeLiveHooks,
  type ProbeScripts,
  type ProbeScriptsOptions,
  type ProbeScriptsResult,
} from "./probeScripts";
import {
  createProbeMedia,
  checkProbeMedia,
  type ProbeMedia,
  type ProbeMediaResult,
  type ProbeMediaStep,
} from "./probeMedia";
import { prepareProbeTexts } from "./probeTexts";
import type { UserProperty } from "../compile/bindings";
import { checkGifDts, prepareProbeUserTextures, type ProbeShortcutIconInput } from "./probeUserTextures";
import {
  checkCanvas,
  expandInputTimeline,
  pointerWindow,
  replayPointers,
  sceneCursors,
  type InputTimelineEntry,
} from "./replayPointers";
import { applyScriptValues, wroteTextValues, type ScriptValue, type ScriptValueResult } from "./scriptValues";
import {
  checkVideoTime,
  ProbeVideos,
  requestedVideoTime,
  type ProbeVideoResult,
  type VideoTimeOption,
} from "./videoProbe";

/** 探针结果的存放处：键 → 字节（PNG、原始像素），由 `chunk` 分块取走。 */
const stored = new Map<string, Uint8Array>();

export function storeProbeBytes(key: string, bytes: Uint8Array): void {
  stored.set(key, bytes);
}

/** 清掉结果键 `key` 名下旧的轨迹与读回图（`drawTrace.ts` 的 `isTraceKey`）：同键再渲染时不越积越多。 */
function dropTraceBytes(key: string): void {
  for (const stale of [...stored.keys()]) if (isTraceKey(key, stale)) stored.delete(stale);
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
  /** 「场景反射」设置（P13b2）：缺省取 dev 覆盖（`dev/reflectionOverride.ts`），再缺省跟随 WPE。 */
  reflection?: SceneReflectionSetting;
  /** 「场景阴影」设置（P13d）：缺省取 dev 覆盖（`dev/shadowsOverride.ts`），再缺省跟随 WPE。 */
  shadows?: SceneShadowSetting;
  /** 「场景体积光」设置（P13e）：缺省取 dev 覆盖（`dev/volumetricsOverride.ts`），再缺省跟随 WPE。 */
  volumetrics?: SceneVolumetricsSetting;
  userProperties?: Record<string, unknown>;
  /**
   * 快捷方式图标（P11d）：属性名 → 宽高与 base64 的直通 alpha RGBA。探针没有后端，快捷方式槽的图标只能由请求给（没给 = 没有图标，用缺省纹理）；
   * 属性的 `userProperties` 值可以给后端形状 `{ value, isbound, commandtype?, file? }`，`value` 是键（图标不取决于它，只按属性名取）。
   */
  shortcutIcons?: Record<string, ProbeShortcutIconInput>;
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
   * 逐帧的左键（P6c，场景光标交互）：和 `particles.dts` 等长（第 i 项是第 i + 1 帧），要有 `particles` 与 `scripts`；缺的项按松开。每帧按
   * `pointers` 的位置在相机更新之后、脚本之前命中、派发光标回调（`render/cursor.ts`），脚本的 `input.cursorLeftDown` 读到它。
   * 不和 `inputTimeline` 同给。
   */
  buttons?: boolean[];
  /**
   * wpe-renderdoc 的输入时间线（P6c）：`[x, y, down]` 或 `[x, y, down, n]`（重复 n 帧），x / y 是抓帧窗口客户区归一化坐标，展开后等于 `particles.dts`
   * 的帧数。同时给 `pointers` 与 `buttons`：指针按 WPE 的取法量化到整数像素（`expandInputTimeline`，`window ?? canvas` 是窗口像素，必须给），
   * 所以和 WPE 日志里的世界坐标 / 局部坐标逐位相同。不和 `pointer` / `pointers` / `buttons` 同给。
   */
  inputTimeline?: InputTimelineEntry[];
  /**
   * 抓帧窗口尺寸 `[宽, 高]`（像素）：和场景不同尺寸时，光标（`pointer` / `pointers`）按壁纸样式 `fill` 换到场景上推出 cursor
   * （`sceneCursor`，同渲染器与 kbp replay），`g_PointerPosition` 仍是窗口坐标；缺省或同尺寸时原样。没给时取 `canvas`；两个都给
   * 而不相等时抛错（`pointerWindow`）。
   */
  window?: [number, number];
  /**
   * 窗口（画布）尺寸 `[宽, 高]`（像素，两个正整数，各不超过设备的 `maxTextureDimension2D`，否则抛错），模拟的壁纸窗口：
   * - 正交场景缺省**按这个尺寸画**（`renderMode: "target"`）：场景目标就是它，`style` 做进正交投影的裁切边距，读回场景目标本身；
   *   `g_Screen`、快照、泛光、反射、深度、fullscreen 合成 RT 随它走；光标按窗口坐标（见 `style`）。
   * - `renderMode: "scene"` 时是旧的读回画布：场景按场景分辨率画，读回那一帧用产品上屏的同一份着色器与线性采样器（`render/blit.ts`）
   *   按 `fill` 铺进这么大的 `rgba8unorm` 纹理；只改读回、不改渲染，`g_Screen` 等仍按场景目标算，同产品。
   * - 透视场景本来就按它画（P5d 步骤 2）。
   * PNG 与 `.rgba` 都是这个尺寸；没给 `window` 时光标按它换算。不给时读回场景目标，逐字节同以前。
   */
  canvas?: [number, number];
  /**
   * 壁纸样式（只在按指定尺寸画时有效）：`fill` 等比盖满裁溢出（WPE 对齐方式 0，缺省，WPE 测试窗口的缺省）、`fit` 等比放进留白（1，WPE 叫 fill）、
   * `stretch` 拉满（2）、`center` 一个场景像素对一个窗口像素（3）；`tile` 没有对应的对齐方式，报错。对齐方式 1 / 3 整个目标清成 `schemecolor`
   * （用户属性已并进，工程没声明时 0.5 灰），0 / 2 用 `clearcolor`。其它画法（`scene`、透视、没给 `canvas`）下给了非 fill 的值报错。
   */
  style?: "fill" | "fit" | "stretch" | "center";
  /**
   * 给了 `canvas` 时怎么画：`target`（缺省，正交场景按 `canvas` 尺寸画）或 `scene`（旧的读回画布：场景分辨率 + 读回时按 fill 铺放，字节同以前）。
   * 显式要 `target` 而没给 `canvas` 报错；透视场景不看它。
   */
  renderMode?: "target" | "scene";
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
   * 文本层的运行中字段（P6b 1e-3，`TEXT_RUNTIME_FIELDS`）：`value` 还可以是字符串（例如 WPE 抓帧里时钟画的「12:34」），按宿主同一条
   * 写回规整后经 `writeText` 写进状态，回放之前结清重排（缺字体时等读完），读回那一帧画的就是这串文字。
   */
  scriptValues?: ScriptValue[];
  /**
   * 跑场景脚本（kabegame-chromium 第 7 批，`probeScripts.ts`）：`true`，或 `{ clock?: 起点时刻（毫秒时间戳）, seed?: Math.random 的种子 }`。
   * 建好场景、视频就绪之后跑 `init`，回放的每一帧（含读回帧）在设好相机、推进完关键帧动画之后跑一帧脚本，profile 帧不跑。脚本看到的
   * `engine.runtime` / `frametime` 是回放的这一帧（不回放时是 `time` 与 0），`screenResolution` 是 `canvas ?? window ?? [1920, 1080]`，`Date` 与
   * `engine.timeOfDay` 是 `clock`（缺省 `DEFAULT_PROBE_CLOCK`）加回放时间、`g_Daytime` 跟着它（每帧都画时每一帧，否则读回帧），`Math.random` 按 `seed`（缺省 1），
   * `localStorage` 只在内存，音频缓冲全 0，声音 / 视频 / 粒子层的方法空操作并计数。要整场重编译的写入做不了，记进结果。
   * 不和 `scriptValues` 同给（一个让脚本自己算，一个把脚本的结果塞进去）。不给时不跑脚本，逐字节同以前。
   */
  scripts?: true | ProbeScriptsOptions;
  /**
   * 视频纹理的时刻（P9a 步骤 3，秒，非负有限数）：数字对全部视频纹理生效；`{ <bundle 纹理的 path>: 秒 }` 分别给，没给的取 0，键不是
   * 这个场景的视频纹理时抛错。缺省 0。超过时长时按循环取模（WPE 视频纹理缺省循环），再钳到 `[0, duration − 0.005]`。屏外宿主不跑帧
   * 循环、视频用自己的时钟（不跟 `g_Time`），这是确定性回放视频的唯一办法。实际取的时刻见结果的 `videos`。
   */
  videoTime?: VideoTimeOption;
  /**
   * 用户纹理里 GIF 的推进（P11b 步骤 4）：每项是一帧的 `g_Frametime`（秒，有限非负）。场景建好、读回之前逐项 `beginFrame(dt)` + 推进一次，
   * 相当于 GIF 每帧都被画到；读回那一帧不再推进（帧号已经等于上次推进的）。不给时 GIF 停在第 0 帧（第一次画到时 dt 为 0、不换帧，
   * 延时 0 的第 0 帧除外）。`videoTime` 同样作用于用户视频：数字对全部，对象的键除了 bundle 视频纹理的 `path` 也可以是用户视频的值。
   */
  gifDts?: number[];
  /**
   * 系统媒体回放（P11c，`probeMedia.ts`）：`[{ frame, messages }]`，在第 `frame` 帧（1 起，同 `particles.dts` 的第 i 项是第 i + 1 帧；没有回放时读回帧
   * 是第 1 帧）之前把这批后端场景投影的消息并进一个 `MediaPending`、立刻 `flush` 进场景队列（不走计时器），这一帧脚本阶段开头取空、逐条派发
   * （封面先换名并换纹理、再依次调 状态 → 播放 → 属性 → 封面 → 时间轴 回调）。封面（`sceneThumbnail`）先等解码完。回调要同时给 `scripts: true`
   * （可加 `consoleGrep` 拿回调日志）；只有封面纹理的场景不需要脚本。`init` 之后照宿主补发一轮（`{enabled: true}` 等）。
   */
  media?: ProbeMediaStep[];
  /**
   * 逐 draw 轨迹（`.claude/plans/tools/scene-draw-trace.md`）：`true`，或 `{ readback?: (pass 下标 | 标签子串)[], maxVertices?: 1–4096 }`。
   * 给了就把设备换成记录器包过的那个（`render/trace.ts`），读回那一帧记下每个 pass、每个 draw 的管线、绑定、uniform（按反射解码）、
   * 顶点与索引（每个 draw 前 `maxVertices` 个，缺省 64），轨迹存成 `<key>.trace.json`；`readback` 选中的 pass 结束后读回它的颜色附件 0，
   * 8 位目标存 `<key>.pass<下标>.png`（RGBA 原值），浮点目标存 `<key>.pass<下标>.f32`。不给时设备不包、逐字节同以前。
   */
  trace?: boolean | TraceOptions;
  /**
   * 运行中建层的预跑（L5）：要和 `scripts` 一起给。先按同样的请求空跑一遍（建场景、`init`、回放，不读回），收集脚本 `createLayer` 建出的配置，经编译会话
   * 编好进片段缓存，再正式跑：第一轮就命中缓存、当场装上，和 WPE 逐帧比时用。预跑那一遍建的层只建壳（不编、不画），所以靠读新层的值才决定建什么的
   * 脚本可能收集不全，正式那一遍没命中的照产品晚几帧（读回帧之前赶不上）。不给时照产品行为：第一次出现的配置没命中缓存，不当帧画出。
   */
  prewarmFragments?: boolean;
}

export interface RenderFrameResult {
  /** 读回图片的尺寸：给了 `canvas` 时是画布，否则是场景目标（按指定尺寸画时两者相同）。 */
  width: number;
  height: number;
  /** 这次的画法（`renderTarget.ts`）：模式、样式、对齐方式、投影裁切边距与清屏色。 */
  render: RenderDescription;
  /** 读回的画布 `[宽, 高]`；没给 `canvas`（读回场景目标）时为 null。 */
  canvas: [number, number] | null;
  /** 场景目标（离屏渲染目标）的尺寸：场景分辨率（超过设备上限时等比缩小）；按指定尺寸画时是 `canvas`。 */
  sceneTarget: [number, number];
  /** 场景目标的格式（`rgba16float` 是 HDR 场景）；读回的画布总是 `rgba8unorm`。 */
  format: string;
  unsupported: string[];
  postprocess: SceneBundle["general"]["postprocess"];
  /** 实际生效的阴影档位（P13d，0 关闭 … 4 超高）与阴影计数；场景没有开光照的材质（`bundle.lights` 缺）时为 null。 */
  shadows: { quality: number; pointShadow: number; directionalShadow: number } | null;
  /** 实际生效的体积光档位（P13e，1 低 … 4 超高）与会画的灯（`objects` 下标）；没有会画的灯或档位关闭时为 null。 */
  volumetrics: { quality: number; lights: number[] } | null;
  /** 8 位 RGB（alpha 置 255）的 SHA-256：关闭档前后两版逐字节比较用。 */
  sha256: string;
  /** 三通道平均值（0–255），确认不是空图。 */
  mean: [number, number, number];
  compileMs: number;
  /** 渲染目标类资源的显存估算（字节）。 */
  targetBytes: number;
  /** 泛光链：HDR 级数（LDR 为 0）；没有泛光为 null。 */
  bloomLevels: number | null;
  /**
   * sprite 的遮挡计数（P13c 走查，`GpuScene.spriteSamples`）：`previous` 是读回帧之前那一帧数到的 n（读回帧算 k 用它），`k` 按它算
   * （`spriteScale`，场景目标高），`samples` 是读回帧自己数到的 n。读回帧之前没画过的 sprite 不列；没有 sprite 时没有这一项。
   */
  sprites?: { object: number; previous: number; k: number; samples: number }[];
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
  /**
   * 关键帧动画（P10a 步骤 3）在读回那一帧的状态，顺序同 `bundle.animations`：`id`、时钟主人、`t`、`getFrame()`、`isPlaying()`、标志与最后
   * 写入的值（`value`，不写的为 null）。有 `particles.dts` 时是沿同一串 dt 推进到读回帧的，没有时是 `seek(time)` 的。没有动画时空数组。
   */
  animations: AnimationProbeEntry[];
  /**
   * 回放之前结清文本重排调了几次 `sync`（P6b 1e-3，`ProbeTexts.settle`）：1 是一次就排成，多出来的每次是等了一轮字体。只在有文本字段的
   * 脚本值写进了状态时给。跑脚本时（第 7 批）是读回帧之后结清的次数，只在场景有文本层时给。
   */
  textSyncs?: number;
  /** 系统媒体回放的结果（P11c，`ProbeMediaResult`）：只在给了 `media` 时有。 */
  media?: ProbeMediaResult;
  /** 跑场景脚本的结果（第 7 批，`ProbeScriptsResult`）：只在给了 `scripts` 时有。 */
  scripts?: ProbeScriptsResult;
  /**
   * 运行中建层（L5）：只在给了 `scripts` 时有。`sync` / `async` / `unsupported` 同宿主 `stats.created`；`pending` 是读回时还没接上的（没命中缓存、
   * 片段赶不上读回帧）；`reloads` 是宿主会整场重载、探针做不了的原因（片段带 `sceneFlips`、编失败、装 GPU 出错）；`unsupportedKeys` 是运行中出现的
   * 不支持项；`prewarmed` 是预跑编进缓存的配置数（没给 `prewarmFragments` 时 0）；`recompiles` 是单对象重编译（L6）真正向会话要片段的次数（合并之后的）。
   */
  liveCreate?: {
    sync: number;
    async: number;
    unsupported: number;
    pending: number;
    reloads: string[];
    unsupportedKeys: string[];
    prewarmed: number;
    recompiles: number;
  };
  /** 结构变化（换父、删除生效）当场重算组与挂点、交给 GPU 当帧重排的次数（L7，同宿主 `stats.restructured`）：只在给了 `scripts` 时有。 */
  restructured?: number;
  /**
   * 每段视频纹理实际取的时刻（P9a 步骤 3，顺序同 bundle 纹理）：`time` 是 seek 完读回的 `currentTime`、`duration` 是时长（未知时 null）、
   * `width` / `height` 是视频尺寸；`failed` 的那段保持透明（同产品），原因在 `error`。没有视频纹理时空数组。
   */
  videos: ProbeVideoResult[];
  /** 用户纹理属性来源的解码结果（P11b 步骤 2，`UserTextureProbe`）：值、状态、尺寸、解码用时与已登记的纹理名；没有属性来源时不给。 */
  userTextures?: UserTextureProbe[];
  /** PNG 的存放键是 `<key>.png`，原始 RGBA 是 `<key>.rgba`，都用 `chunk` 取（base64 分块）。 */
  key: string;
  /** 逐 draw 轨迹的键与摘要（`drawTrace.ts` 的 `RenderFrameTrace`）：只在给了 `trace` 时有。 */
  trace?: RenderFrameTrace;
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

/** `renderFrame` 先查的参数（参数错时不编译）。 */
interface CheckedRenderFrame {
  canvas: [number, number] | undefined;
  cursorWindow: ReturnType<typeof pointerWindow>;
  style: ReturnType<typeof checkRenderStyle>;
  renderMode: ReturnType<typeof checkRenderMode>;
  videoTime: ReturnType<typeof checkVideoTime>;
  gifDts: ReturnType<typeof checkGifDts>;
  mediaSteps: ReturnType<typeof checkProbeMedia>;
  traceOptions: ReturnType<typeof traceOptionsOf>;
  scriptsOptions: ReturnType<typeof probeScriptsOptionsOf>;
}

function checkRenderFrame(options: RenderFrameOptions): CheckedRenderFrame {
  // 先查读回画布与光标窗口（`window ?? canvas`，两个都给而不同时抛错），参数错时不编译；纹理上限要等取到设备再查
  const canvas = options.canvas === undefined ? undefined : checkCanvas(options.canvas);
  const cursorWindow = pointerWindow(options.window, canvas);
  // 样式与画法（phase-render-size）的形状同样先查；用不用得上要等编译出场景才知道（透视或正交）
  const style = checkRenderStyle(options.style);
  const renderMode = checkRenderMode(options.renderMode);
  if (renderMode === "target" && !canvas) throw new Error("renderMode: target 要同时给 canvas（按它的尺寸画）");
  // 视频时刻（P9a 步骤 3）的形状同样先查；路径对不对要编译之后才知道（`ProbeVideos` 里查）
  const videoTime = checkVideoTime(options.videoTime);
  const gifDts = checkGifDts(options.gifDts);
  const mediaSteps = checkProbeMedia(options.media);
  // 逐 draw 轨迹：形状同样先查；没要时为 null，下面不建记录器、设备不包
  const traceOptions = traceOptionsOf(options.trace);
  // 跑场景脚本（第 7 批）：形状与互斥同样先查；没要时为 null，下面不建脚本环境
  const scriptsOptions = probeScriptsOptionsOf(options.scripts);
  if (scriptsOptions && options.scriptValues !== undefined)
    throw new Error("scripts 与 scriptValues 不能同时给：一个让脚本自己算，一个把脚本的结果塞进去，混用分不清是谁写的");
  if (options.prewarmFragments && !scriptsOptions)
    throw new Error("prewarmFragments 要和 scripts 一起给（预跑的是脚本建的层）");
  return { canvas, cursorWindow, style, renderMode, videoTime, gifDts, mediaSteps, traceOptions, scriptsOptions };
}

/** 两遍（预跑与正式）共用的编译结果：常驻会话（L5，运行中建层编片段用）、bundle、片段缓存与读文件的缓存。 */
interface ProbeCompiled {
  bundle: SceneBundle;
  session: CompileSessionClient;
  /** 片段缓存：按 bundle 与会话的 `exactConfigs` 预置，预跑编好的也进来 */
  cache: FragmentCache;
  reader: FetchSceneReader;
  textures: TextureDecodeCache;
  compileMs: number;
  force: boolean;
}

/** 预跑（`prewarmFragments`）之后交给正式那一遍的：编好的片段的增量（按编的先后，正式那一遍的登记表先接上场景级部分）与新建对象下标的下界。 */
interface ProbePrewarm {
  deltas: FragmentDelta[];
  firstObject: number;
}

/**
 * 编译并按固定时刻渲染一帧，读回离屏场景目标（不经过页面上的画布、不做铺放）；给了 `canvas` 时读回按 `fill` 上屏到这么大的画布
 * （`encodeCanvasBlit`）。
 *
 * 编译经常驻的编译会话（L5，`openSceneSession`），读回之后关掉。脚本 `createLayer` 建的层和宿主走同一份两条路（`script/createLayerChange.ts`）：命中片段缓存
 * 当场装上；没命中的排给会话，`init` 里建的等片段到齐再画首帧（同宿主，不再整场补编），回放中途建的赶不上读回帧（探针的回放是同步的）。
 * `prewarmFragments` 先预跑一遍收集建出的配置、编进缓存，正式那一遍第一轮就命中。
 */
export async function renderFrame(options: RenderFrameOptions): Promise<RenderFrameResult> {
  const checked = checkRenderFrame(options);
  const started = performance.now();
  const reader = new FetchSceneReader();
  const textures = new TextureDecodeCache(reader);
  const force = options.force ?? true;
  const { bundle, session, exactConfigs } = await openSceneSession({
    projectDir: options.projectDir,
    sceneAssets: options.sceneAssets,
    userProperties: options.userProperties,
    postprocess: options.postprocess ?? "disabled",
    reflection: options.reflection ?? reflectionOverride() ?? undefined,
    shadows: options.shadows ?? shadowsOverride() ?? undefined,
    volumetrics: options.volumetrics ?? volumetricsOverride() ?? undefined,
    force,
    textureCache: textures,
    reader,
  });
  const cache = new FragmentCache();
  cache.seed(bundle, exactConfigs);
  const compiled: ProbeCompiled = {
    bundle,
    session,
    cache,
    reader,
    textures,
    compileMs: performance.now() - started,
    force,
  };
  try {
    let prewarm: ProbePrewarm | null = null;
    if (options.prewarmFragments) {
      const dry = await renderFramePass(options, checked, compiled, { dry: true });
      prewarm = await prewarmFragments(compiled, dry.created, options);
    }
    return await renderFramePass(options, checked, compiled, { dry: false, prewarm });
  } finally {
    session.close();
    // 视频纹理以外的位图（FreeImage 解码结果）跟着 bundle：两遍都用完才释放
    for (const texture of bundle.textures) for (const mip of texture.mips) mip.bitmap?.close();
    textures.clear();
  }
}

/**
 * 预跑之后：建出的配置（去重，缓存里已有的跳过）逐个经会话编成片段进缓存，下标从 bundle 的配置个数起（会话只收新下标）。返回增量（正式那一遍的登记表要先
 * 接上它们的场景级部分：片段里的程序、纹理下标指向这些新增项）与正式那一遍新建对象下标的下界。编失败的跳过（会话坏了之后的也编不了，正式那一遍没命中的
 * 照样记进 `reloads`）。
 */
async function prewarmFragments(
  compiled: ProbeCompiled,
  created: readonly { config: string }[],
  options: RenderFrameOptions,
): Promise<ProbePrewarm> {
  const { bundle, session, cache, reader } = compiled;
  const properties = await readProbeUserProperties(
    reader,
    options.projectDir,
    options.sceneAssets,
    options.userProperties,
  );
  const raw = Object.fromEntries([...properties].map(([key, property]) => [key, property.value]));
  const deltas: FragmentDelta[] = [];
  let next = bundle.configs?.length ?? 0;
  for (const { config } of created) {
    const key = fragmentKey(config);
    if (key === null || cache.has(key)) continue;
    let delta: FragmentDelta;
    try {
      delta = await session.compileFragment({ object: next++, config, parent: null, bone: null, properties: raw });
    } catch {
      continue;
    }
    deltas.push(delta);
    if (!delta.fragment.sceneFlips.length) cache.put(key, cacheCopy(delta.fragment));
  }
  return { deltas, firstObject: next };
}

async function renderFramePass(
  options: RenderFrameOptions,
  checked: CheckedRenderFrame,
  compiled: ProbeCompiled,
  mode: { dry: true },
): Promise<{ created: { config: string }[] }>;
async function renderFramePass(
  options: RenderFrameOptions,
  checked: CheckedRenderFrame,
  compiled: ProbeCompiled,
  mode: { dry: false; prewarm: ProbePrewarm | null },
): Promise<RenderFrameResult>;
/**
 * 建场景、跑脚本、回放、读回的一遍。`mode.dry`（`prewarmFragments` 的预跑）：脚本 `createLayer` 只建壳并记下配置，不读回、不 profile、不记轨迹，返回记下的配置；
 * 不动 bundle（正式那一遍还要用）。正式那一遍：预跑编好的增量先接进登记表、建好场景后预热它们的程序与管线。
 */
async function renderFramePass(
  options: RenderFrameOptions,
  checked: CheckedRenderFrame,
  compiled: ProbeCompiled,
  mode: { dry: true } | { dry: false; prewarm: ProbePrewarm | null },
): Promise<RenderFrameResult | { created: { config: string }[] }> {
  const { canvas, cursorWindow, style, renderMode, videoTime, gifDts, mediaSteps, scriptsOptions } = checked;
  const traceOptions = mode.dry ? null : checked.traceOptions;
  const { bundle, reader, force, compileMs } = compiled;
  const prewarm = mode.dry ? null : mode.prewarm;
  // 登记表（L5）：运行中建层接进它；预跑编好的增量先接上场景级部分（片段里的程序、纹理下标指向它们）。预跑那一遍不建（不动 bundle）
  const registry = mode.dry ? null : new SceneRegistry(bundle);
  for (const delta of prewarm?.deltas ?? []) registry!.applyDelta(delta);
  // 文本层（P6b 1d）：同宿主，建场景前排好；没有文本层时不碰 wasm
  const texts = await prepareProbeTexts(bundle, reader, options.sceneAssets);
  // 用户纹理（P11b 步骤 2）：按 `userProperties` 预先解码并等完，读回的就是用户图；没有属性来源时不建
  const userTextures = await prepareProbeUserTextures(bundle, options.userProperties, reader, options.shortcutIcons);
  const gpu = await acquireGpu();
  // 逐 draw 轨迹：建场景、编码都用包过的设备（返回的仍是真对象）；没要轨迹时就是 `gpu.device` 本身
  const tracer = traceOptions ? createDrawTracer(gpu.device, traceOptions) : null;
  const device = tracer?.device ?? gpu.device;
  let videos: ProbeVideos | undefined;
  try {
    if (canvas) checkCanvas(canvas, gpu.device.limits.maxTextureDimension2D);
    // 视频时刻（P9a 步骤 3）：对象里不是视频纹理的路径在这里抛错；读、seek 与建场景并行，第一次编码之前等它。建场景出错时
    // finally 里的 dispose 让它以「已释放」失败，先挂一个空的 catch，不留未处理的拒绝
    // 用户视频（P11b 步骤 4）的值也是 `videoTime` 对象的合法键
    const userVideoValues = (userTextures?.probe() ?? [])
      .filter((item) => item.kind === "video")
      .map((item) => item.value);
    const sink = new ProbeVideos(bundle.textures, videoTime, {}, userVideoValues);
    videos = sink;
    const videosReady = sink.prepare();
    videosReady.catch(() => {});
    const state = SceneState.fromBundle(bundle);
    const { width: sceneWidth, height: sceneHeight } = bundle.general;
    // 按指定尺寸画（phase-render-size）：正交场景给了 `canvas` 且没要 `scene` 时，场景目标 = 画布，样式做进投影裁切边距；清屏色只在
    // 对齐方式 1 / 3 时要，从属性全集（用户值已并入）取
    const perspectiveScene = !!bundle.general.perspective;
    const sized = wantsSizedTarget({ renderMode, hasCanvas: !!canvas, perspective: perspectiveScene })
      ? planSizedTarget(
          [sceneWidth, sceneHeight],
          canvas!,
          style,
          styleNeedsSchemeColor(style)
            ? schemeColor(
                await readProbeUserProperties(reader, options.projectDir, options.sceneAssets, options.userProperties),
              )
            : undefined,
        )
      : null;
    const render = sized?.render ?? otherRender(perspectiveScene ? "perspective" : "scene");
    if (!sized) checkStyleUnused(style, options.style !== undefined, render.mode as "scene" | "perspective");
    // 裁切（相机对象帧与 `GpuScene` 的投影都带它）；窗口就是画布
    const crop = sized ? { edges: sized.target.edges, window: sized.target.size } : undefined;
    // 透视场景（P5d 步骤 2）按画布尺寸渲染：场景目标取 `canvas ?? window ?? [1920, 1080]`（同渲染器的 `fullResolution`）
    const target: [number, number] | undefined = bundle.general.perspective
      ? [...(canvas ?? cursorWindow ?? [1920, 1080])]
      : undefined;
    const perspective = target && probePerspective(bundle, target);
    // 每一帧的 g_PointerPosition 与 cursor（P5a 收尾）：只给 pointer（或都不给）时每帧相同，同加逐帧指针之前。
    // 换算窗口是 `window ?? canvas`（第 5 批）：读回画布就是模拟的壁纸窗口
    // 输入时间线（P6c）：展开成逐帧指针与左键；左键另交给脚本的光标命中
    if (options.inputTimeline !== undefined && (options.pointer || options.pointers || options.buttons))
      throw new Error("inputTimeline 不能和 pointer / pointers / buttons 同给（它自己展开成逐帧指针与左键）");
    if (options.inputTimeline !== undefined && !cursorWindow)
      throw new Error("inputTimeline 要同时给 window（或 canvas）：指针按窗口像素量化，和 WPE 的整数像素一致");
    const timeline =
      options.inputTimeline && cursorWindow ? expandInputTimeline(options.inputTimeline, cursorWindow) : null;
    const buttons = timeline?.buttons ?? options.buttons;
    if (buttons) {
      if (!options.particles?.dts.length)
        throw new Error("buttons / inputTimeline 要和 particles 一起给（逐帧左键是回放的每一帧）");
      if (buttons.length !== options.particles.dts.length)
        throw new Error(
          `buttons / inputTimeline 有 ${buttons.length} 帧，应和 particles.dts 等长（${options.particles.dts.length} 项）`,
        );
    }
    const pointers = replayPointers(
      {
        pointer: options.pointer,
        pointers: timeline?.pointers ?? options.pointers,
        window: cursorWindow,
        // 按场景分辨率画（旧模式）时同产品渲染器：光标的裁切在反投影里（P6c 修复 2）
        cropped: !sized && !perspective,
      },
      // 按指定尺寸画时窗口就是场景目标：光标原样（`windowPointer` 的同尺寸分支），反投影交给带裁切的 VP
      target ?? (sized ? sized.target.size : [sceneWidth, sceneHeight]),
      options.particles?.dts.length,
    );
    const scene = await GpuScene.build(device, bundle, state, gpu.features, [], {
      ...(registry ? { particleOrdinal: (object: number) => registry.particleOrdinal(object) } : {}),
      ignoreUnsupported: force,
      particles: {
        ...replayParticleOptions(options.particles),
        cursor: pointers.warmup,
        cursorCrop: pointers.cursorCrop,
      },
      texts: texts.texts,
      relayout: texts.relayout,
      userTextures,
      size: target,
      ...(sized ? { target: sized.target } : {}),
    });
    // 脱离的纹理动画图层画自己的帧（P6e 点 3，同宿主的 `sheetOverride`）；推进在 `stepParticles` 里
    scene.setSheetOverrides((object) => textureAnimationOverride(state.textureAnimations.get(object)));
    // 视差（P5a 步骤 2）：从加载时的场景中心起，每一帧（profile 帧、回放帧、读回帧）按它的帧时间推进一次，同渲染器；profile 帧用第 0 项的指针
    const pointer = pointers.pointers[0];
    const cursor = pointers.cursors[0];
    const parallaxFrame = { pointer, width: sceneWidth, height: sceneHeight };
    let parallax = initialParallaxState(sceneWidth, sceneHeight, !!perspective);
    // profile 帧的相机（透视场景的路径状态接着交给回放，同视差点）；相机对象（P5d 步骤 3）每帧按状态选，同渲染器
    const baseCameraObjects = probeCameraObjects(bundle);
    const cameraObjects = baseCameraObjects && crop ? { ...baseCameraObjects, crop } : baseCameraObjects;
    const profileCamera = frameCamera(scene, state, sceneHeight, perspective, undefined, cameraObjects);
    // 场景脚本（第 7 批）：建好之后读回之前一直在，出错也在 finally 里释放
    let probeScripts: ProbeScripts | null = null;
    let probeMedia: ProbeMedia | null = null;
    let live: LiveObjects<PreparedObject> | null = null;
    try {
      // 预跑编好的片段（L5）：程序与管线先在这个场景上预热，正式回放里命中缓存的就能同步备好、当帧装上
      for (const delta of prewarm?.deltas ?? []) {
        try {
          scene.discardPrepared(await scene.prepareObject(delta.fragment.layer, state));
        } catch {
          // 预热只是让装入时能同步备好；备不好的到时候走异步
        }
      }
      // 视频（P9a 步骤 3）：每段都 seek 好、当前帧可用之后才接上，profile 帧与读回那一帧的每个 draw 都拷同一帧；没有视频纹理时
      // 没有 draw 会问它，逐字节同以前。读不到 / 解码失败的那段不交出元素（透明），超过总时限在这里抛错
      await videosReady;
      scene.setVideoSink(sink);
      // 用户纹理（P11b 步骤 4）：用户视频 seek 到 `videoTime` 的时刻（没给取 0）、GIF 按 `gifDts` 逐帧推进；都在建场景之后（各纹理名的帧状态
      // 由 `crop` 登记），读回那一帧画到时上传。没有 GIF / 视频时不碰，逐字节同以前
      if (userTextures) {
        await userTextures.seekVideos((value) => requestedVideoTime(videoTime, value));
        for (const dt of gifDts ?? []) {
          userTextures.beginFrame(dt);
          userTextures.advanceGifs();
        }
      }
      // 脚本值（第 6 批）：建好场景之后、回放之前写进状态，同宿主的脚本写回；第一次 `sync` 把它刷进 uniform
      const scriptValues = applyScriptValues(state, bundle, options.scriptValues);
      // 文本字段（P6b 1e-3）：写进状态只是标脏，重排在 `sync` 里；缺字体时重排器照画旧排版、后台读字体，探针没有帧外的补画，
      // 回放之前结清（`sync` → 等字体 → 标脏再 `sync`）。没有文本值时不调，逐字节同以前
      let textSyncs = wroteTextValues(scriptValues) ? await texts.settle(scene, state) : undefined;
      // 场景脚本（第 7 批）：建好场景、视频就绪之后搭环境、跑 init，再整份交一次用户属性（同宿主首帧之前）；init 的写入进状态、标脏，
      // 回放第一帧开头的 `sync` 刷进去。脚本的 screenResolution 同透视场景的画布：`canvas ?? window ?? [1920, 1080]`
      // 关键帧动画（P10a 步骤 3）：没有动画时是空表，下面不建播放器，调用序列同以前。跑脚本时播放器要在 `init` 之前建好（P10b：`init` 里的
      // `getAnimation().play()` 才有落点，同宿主的待用播放器），回放推进、读回的就是这一份；不跑脚本时仍在回放之前才建，行为不变。跑脚本时没有动画也建
      // （L5：运行中建的层可能带关键帧）
      const animationList = bundle.animations ?? [];
      const animations = animationList.length || scriptsOptions ? new SceneAnimations(animationList) : null;
      // puppet 的骨骼动画（P12a 步骤 4 点 5）：没有 puppet 图层时不建，调用序列逐字节同以前。有回放时沿同一串 dt 从第 1 帧推进
      // （`replayReadback` 的 `puppets`，粒子之后、相机之前），没有回放时按 `time` 定位（`seek`）；profile 帧另用一份
      const puppetList = puppetEntries(bundle.layers);
      const puppets = puppetList.length ? new ScenePuppets(puppetList) : null;
      if (puppets) {
        puppets.refresh(stateSink(state));
        scene.setPuppets(puppets);
      }
      const probeProperties: Map<string, UserProperty> =
        scriptsOptions && bundle.scripts.list.length
          ? await readProbeUserProperties(reader, options.projectDir, options.sceneAssets, options.userProperties)
          : new Map();
      // 系统媒体回放（P11c）：脚本之前建（`init` 之后的补发读它），消息按帧序并入、等封面解码完、切成事件存好；回放时按帧取
      probeMedia = mediaSteps
        ? await createProbeMedia({
            steps: mediaSteps,
            bundle,
            state,
            sources: userTextures,
            properties: probeProperties,
            scripts: () => probeScripts,
          })
        : null;
      // 预跑那一遍：`createLayer` 只建壳并记下配置（不编、不画、不动 bundle）
      const collected: { config: string }[] = [];
      let liveHooks: ProbeLiveHooks | undefined;
      const reloads: string[] = [];
      const unsupportedKeys = new Set<string>();
      /** 结构变化当场重排的次数（L7，同宿主 `stats.restructured`） */
      const restructured = { count: 0 };
      if (scriptsOptions && mode.dry)
        liveHooks = {
          create: (_object, config) => void collected.push({ config }),
          settle: async () => {},
          drain: () => {},
        };
      else if (scriptsOptions) {
        // 运行中建层（L5）：和宿主同一份两条路，接进这个场景的登记表、状态、子系统与 GPU；结构变化（L7）同宿主当场重算、GPU 当帧重排
        const { live: objects, restructure } = createProbeLive({
          registry: registry!,
          state,
          scene,
          session: compiled.session,
          cache: compiled.cache,
          properties: probeProperties,
          animations,
          puppets,
          reader,
          sceneAssets: options.sceneAssets,
          scripts: () => probeScripts,
          reloads,
          unsupportedKeys,
          restructured,
        });
        live = objects;
        liveHooks = {
          restructure,
          create: (object, config, parent) => void objects.create(object, config, parent),
          settle: async () => {
            // 排着的片段到齐、接上；接上时排出的异步 GPU 对象（文本层等排版）也等完装上
            do {
              await objects.settled();
              objects.drain();
            } while (objects.queue.size > 0);
          },
          drain: () => void objects.drain(),
          // 对象级的重编译写入（L6）：同宿主交给单对象重编译，片段到了在帧边界替换（`adopt` 走替换）
          recompile: (object, overrides, placement, config) =>
            void objects.recompile(object, overrides, placement, config),
        };
      }
      if (scriptsOptions) {
        probeScripts = createProbeScripts({
          bundle,
          state,
          sceneAssets: options.sceneAssets,
          properties: probeProperties,
          screen: [...(canvas ?? cursorWindow ?? [1920, 1080])],
          options: scriptsOptions,
          ...(liveHooks ? { live: liveHooks } : {}),
          ...(prewarm ? { firstObject: prewarm.firstObject } : {}),
          ...(animations ? { animations } : {}),
          ...(puppets ? { puppets } : {}),
          ...(probeMedia ? { media: probeMedia } : {}),
          sheetClock: (texture) => scene.sheetClockOf(texture),
        });
        await probeScripts.load();
      }
      const startTime = options.time ?? 0;
      let frameMs: RenderFrameResult["frameMs"];
      let particleMs: RenderFrameResult["particleMs"];
      if (options.profile && !mode.dry) {
        // 只记 profile 帧：读回那一帧之前取走并关掉
        scene.profileParticles(true);
        // profile 帧另用一份动画、按 1/60 推进（计时含动画开销）；读回那一帧的值由下面另一份决定，不受 profile 帧数影响
        const profiled = animationList.length ? new SceneAnimations(animationList) : null;
        const profiledPuppets = puppetList.length ? new ScenePuppets(puppetList) : null;
        if (profiledPuppets) scene.setPuppets(profiledPuppets);
        const samples: number[] = [];
        for (let i = 0; i < options.profile; i++) {
          const t0 = performance.now();
          // 顺序同渲染器（P4c 步骤 4）：先步进粒子再写 uniform；探针没有脚本，两次 sync 之间没有改动，省掉第二次。
          // 没有脚本，视差在步进之后、update 之前交给场景，结果同渲染器。抖动（P5a 步骤 3）：视差点带这一帧的 s，粒子先用上一帧的
          // s 步进，之后才设这一帧的（同渲染器）；缩放随同一个相机（步骤 4）
          // 透视场景（P5d 步骤 2）：同一时刻按路径状态求相机并推进，eye 是透视相机的 eye.xy
          const { camera, eye } = profileCamera.compute(startTime + i / 60, 1 / 60);
          parallax = advanceParallax(
            parallax,
            parallaxInput(state.general, { ...parallaxFrame, frametime: 1 / 60, eye }),
          );
          // puppet 在粒子之前（P12b1 步骤 3，同渲染器：挂点子对象读本帧姿势）
          profiledPuppets?.frame(1 / 60, stateSink(state));
          scene.sync(state);
          scene.stepParticles(1 / 60, startTime + i / 60, state, cursor);
          scene.setCamera(camera);
          // 关键帧动画在粒子、相机之后写（同渲染器的 `beforeFrame`），写过的由视差之后的 `sync` 刷进 uniform
          profiled?.frame(1 / 60, state);
          scene.setParallax(drawParallax(parallax, state.general, !!perspective), state);
          if (profiled) scene.sync(state);
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
          const encoder = device.createCommandEncoder({ label: "probe profile" });
          scene.encode(encoder, state);
          device.queue.submit([encoder.finish()]);
          await device.queue.onSubmittedWorkDone();
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
        // 读回那一帧用自己的一份（profile 帧推进的是另一份）
        if (puppets) scene.setPuppets(puppets);
      }
      // 粒子回放：前 n−1 帧在 replayParticles 里步进，最后一帧先步进再写 uniform（顺序同渲染器，P4c 步骤 4）。
      // 抖动与缩放（P5a 步骤 3、4）：每一帧先用上一帧的相机步进粒子、再设这一帧的（同渲染器），读回的那一帧同样，之后才 setParallax。
      // 视差点从 profile 帧推进后的状态接着走；逐帧指针（P5a 收尾）第 i 帧用第 i 项，读回帧的 g_PointerPositionLast 是上一帧的。
      // 关键帧动画（P10a 步骤 3）：有回放时沿同一串 dt 推进（每帧在粒子与相机之后写、再 sync）；没有回放时按 `time` 定位、写一次，
      // `replayReadback` 开头的 sync 刷进去
      const replayed = !!options.particles?.dts.length;
      if (animations && !replayed) {
        animations.seek(startTime);
        animations.write(state);
      }
      // puppet：没有回放时按 `time` 定位（回放时 `replayReadback` 逐帧推进）；seek 之后按当前状态再算一次（`visible` 等用户属性）
      if (puppets && !replayed) {
        puppets.seek(startTime);
        puppets.refresh(stateSink(state));
      }
      // 场景脚本（第 7 批）：每一帧设好相机、推进完动画之后跑一帧，`g_Daytime` 跟着脚本的时钟；不跑脚本时这两项不给，逐字节同以前
      const scriptsClock = scriptsOptions?.clock;
      const { time, frametime, frame } = replayReadback(scene, state, {
        particles: options.particles,
        time: startTime,
        pointers,
        parallax,
        size: [sceneWidth, sceneHeight],
        animations: replayed ? (animations ?? undefined) : undefined,
        puppets: replayed ? (puppets ?? undefined) : undefined,
        perspective: perspective && { ...perspective, path: profileCamera.path },
        cameraObjects,
        ...(probeMedia ? { media: probeMedia } : {}),
        // 光标交互（P6c）：脚本在跑才有（命中派发给脚本运行时）；窗口像素同脚本的 `engine.screenResolution`
        ...(probeScripts
          ? {
              cursor: {
                buttons: buttons ?? [],
                window: [...(canvas ?? cursorWindow ?? [1920, 1080])] as [number, number],
              },
            }
          : {}),
        // 回放时前 n − 1 帧每帧都在 GPU 上画（P10a 走查）：被依赖图层的合成 RT、`clearenabled: false` 的累加等跨帧状态同渲染器；
        // 只画场景目标，读回画布与读回只在最后一帧。轨迹从读回帧起记，这些帧只进登记表
        encodeFrame: () => {
          const replayEncoder = device.createCommandEncoder({ label: "probe replay frame" });
          scene.encode(replayEncoder, state);
          device.queue.submit([replayEncoder.finish()]);
        },
        ...(probeScripts && scriptsClock !== undefined
          ? { scripts: probeScripts, daytime: (at: number) => probeDaytime(scriptsClock, at) }
          : {}),
      });
      // 预跑那一遍（L5）：回放完就交出记下的配置，不读回
      if (mode.dry) return { created: collected };
      // 跑脚本时：读回帧脚本写的文字在上面的 `sync` 里重排，缺字体时画的是旧排版（宿主靠之后的帧补上，探针没有）。结清：等字体读完再排，
      // 排过（`sync` 不止一次）就把这一帧的帧输入再写一次（重建的文本 draw 要这一帧的内置 uniform）。没有文本层时不调 `sync`
      if (probeScripts) {
        const syncs = await texts.settle(scene, state);
        if (syncs > 1) scene.update(frame, state);
        if (syncs) textSyncs = syncs;
        // 材质状态字段（P6d1b）：脚本写出的新组合，管线在后台现建（宿主晚几帧换上），探针没有之后的帧，读回之前结清：等建好、`sync`
        // 换上，重建的 draw 再写一次这一帧的帧输入（同 WPE 写入当帧生效）。没有待换的图层时什么都不做，逐字节同以前
        if (await scene.settlePassStates()) {
          scene.sync(state);
          scene.update(frame, state);
        }
      }
      // sprite（P13c 走查）：读回帧之前那一帧数到的 n，读回帧的计算 pass 用它算 k
      const spritesBefore = await scene.spriteSamples();
      // 逐 draw 轨迹：从读回帧（含读回画布）的编码起记；这一帧的校验错误记进轨迹，不吞掉也不中断（轨迹正是查它用的）
      if (tracer) {
        tracer.startFrame();
        device.pushErrorScope("validation");
      }
      const encoder = device.createCommandEncoder({ label: "probe frame" });
      scene.encode(encoder, state);
      const format = scene.targetTexture!.format as ReadbackFormat;
      let raw: Uint8Array | Float32Array;
      // 按指定尺寸画时场景目标就是画布，直接读回它；`scene` 模式才经上屏铺放
      if (canvas && !sized) {
        // 读回画布（第 5 批）：场景之后在同一个编码器里按 fill 上屏到画布纹理再读回。校验错误（比如管线建不出来）不静默读回空图
        device.pushErrorScope("validation");
        const blit = encodeCanvasBlit(device, encoder, scene, canvas);
        try {
          const read = scheduleReadback(device, encoder, blit.texture, canvas[0], canvas[1], "rgba8unorm");
          device.queue.submit([encoder.finish()]);
          const error = await device.popErrorScope();
          if (error) throw new Error(`读回画布时 WebGPU 校验出错：${error.message}`);
          raw = await read();
        } finally {
          blit.release();
        }
      } else {
        const read = scheduleReadback(device, encoder, scene.targetTexture!, scene.width, scene.height, format);
        device.queue.submit([encoder.finish()]);
        raw = await read();
      }
      const spritesAfter = await scene.spriteSamples();
      const sprites = spritesAfter.map(({ object, samples }) => {
        const previous = spritesBefore.find((item) => item.object === object)?.samples ?? 0;
        return { object, previous, k: spriteScale(previous, scene.height), samples };
      });
      const key = options.key ?? `frame-${Date.now()}`;
      let traced: Awaited<ReturnType<typeof traceArtifacts>> | null = null;
      if (tracer) {
        const error = await device.popErrorScope();
        const frame = await tracer.finish();
        if (error) (frame.trace.errors ??= []).push(`读回帧 WebGPU 校验出错：${error.message}`);
        traced = await traceArtifacts(key, frame);
      }
      const [width, height] = canvas && !sized ? canvas : [scene.width, scene.height];
      const rgba = raw instanceof Uint8Array ? raw : quantize8(raw);
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
      storeProbeBytes(`${key}.png`, await encodePng(rgba, width, height));
      storeProbeBytes(`${key}.rgba`, rgba);
      // 同键上次的轨迹与读回图先清掉；这次要了轨迹才存新的
      dropTraceBytes(key);
      for (const file of traced?.files ?? []) storeProbeBytes(file.key, file.bytes);
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
        render,
        canvas: canvas ? [canvas[0], canvas[1]] : null,
        sceneTarget: [scene.width, scene.height],
        format,
        unsupported: bundle.unsupported,
        postprocess: bundle.general.postprocess,
        shadows: bundle.lights
          ? {
              quality: bundle.lights.quality,
              pointShadow: bundle.lights.counts.pointShadow,
              directionalShadow: bundle.lights.counts.directionalShadow,
            }
          : null,
        volumetrics: bundle.volumetrics
          ? { quality: bundle.volumetrics.quality, lights: bundle.volumetrics.lights.map((light) => light.object) }
          : null,
        sha256: await sha256(rgba),
        mean: [sums[0] / count, sums[1] / count, sums[2] / count],
        compileMs,
        targetBytes: scene.targetBytes,
        bloomLevels: scene.bloomChain ? scene.bloomChain.plan.levels : null,
        ...(sprites.length ? { sprites } : {}),
        frameMs,
        particleMs,
        time,
        frametime,
        particles: scene.particleStats(true),
        scriptValues,
        animations: animations?.probe().list ?? [],
        ...(textSyncs === undefined ? {} : { textSyncs }),
        ...(probeScripts ? { scripts: probeScripts.result() } : {}),
        ...(live
          ? {
              liveCreate: {
                ...live.stats,
                pending: live.queue.size,
                reloads,
                unsupportedKeys: [...unsupportedKeys].sort(),
                prewarmed: prewarm?.deltas.length ?? 0,
                recompiles: live.recompileRequests,
              },
              restructured: restructured.count,
            }
          : {}),
        ...(probeMedia ? { media: probeMedia.result() } : {}),
        videos: sink.results(),
        ...(userTextures ? { userTextures: userTextures.probe() } : {}),
        key,
        ...(traced ? { trace: traced.summary } : {}),
      };
    } finally {
      // 脚本环境（第 7 批）：读回之后释放（各段的 destroy、隐藏 iframe），出错也释放
      probeScripts?.dispose();
      probeMedia?.dispose();
      // 运行中建层（L5）：没装上的放弃（场景随之销毁）；缓存跟着会话，留给 `renderFrame` 收尾
      live?.dispose();
      scene.destroy();
    }
  } finally {
    // 视频纹理留下的帧（P9a 步骤 3，P9d 起是解出的 `VideoFrame`）：读回之后释放，出错也释放。bundle 的位图与解码缓存两遍共用，`renderFrame` 收尾
    videos?.dispose();
    userTextures?.dispose();
    texts.dispose();
    gpu.device.destroy();
  }
}

/** `createProbeLive` 的输入：正式那一遍的登记表、状态、场景、会话、缓存与子系统。 */
interface ProbeLiveInput {
  registry: SceneRegistry;
  state: SceneState;
  scene: GpuScene;
  session: CompileSessionClient;
  cache: FragmentCache;
  properties: ReadonlyMap<string, UserProperty>;
  animations: SceneAnimations | null;
  puppets: ScenePuppets | null;
  reader: FetchSceneReader;
  sceneAssets: readonly string[];
  /** 脚本环境（建在 `LiveObjects` 之后，接入时现取） */
  scripts: () => ProbeScripts | null;
  /** 宿主会整场重载、探针做不了的原因（记进结果） */
  reloads: string[];
  /** 运行中出现的不支持项（记进结果） */
  unsupportedKeys: Set<string>;
  /** 结构变化当场重排的次数（L7，记进结果） */
  restructured: { count: number };
}

/**
 * 探针的运行中建层（L5）与单对象重编译（L6）：宿主同一份 `LiveObjects`（两条路、缓存、队列），接进场景的那一侧照宿主 `addCompiledObject(replace)` 的顺序：
 * 登记表（没有时加、有时换）→ 状态换成编好的 → 组与挂点 → 绑定按当前属性重写 → 关键帧（按 id 接回时钟）→ puppet（先摘旧的）→ 文本（排版异步；替换已有
 * 排版时旧的先留在状态里，新的换上时放掉）→ 脚本。GPU 直接调 `GpuScene`（探针没有渲染器），单对象重编译的片段带不支持项时卸掉旧的运行时。声音、视频、
 * 用户纹理、媒体探针本来就不接，这里也不接。场景没有 puppet 图层时新建对象的骨骼动画不推进（探针的 puppet 运行时按 bundle 建，没有时不建）。宿主「片段
 * 过期再编一次」的规则探针不做：一次回放里属性不变。
 * 结构变化（L7，`restructure`，探针脚本的换父 / 删除钩子调）：同宿主 `applyRestructure`，登记表当场重算，组内不支持组合那个对象不画（键记进
 * `unsupportedKeys`）、出组照常装回，其余变了的交给 `GpuScene.restructure`，下一次 `sync`（这一帧脚本之后）重排；重排失败时 `sync` 抛错（探针不重载）。
 */
function createProbeLive(input: ProbeLiveInput): {
  live: LiveObjects<PreparedObject>;
  restructure(removed?: readonly number[]): void;
} {
  const { registry, state, scene } = input;
  let texts: SceneTexts | null = null;
  /** 组内不支持组合（同宿主 `groupIssues` / `groupHidden`） */
  const groupIssues = new Map<number, string[]>();
  const groupHidden = new Set<number>();
  const bones = (item: number) => configBone(registry.bundle, input.scripts()?.structure?.() ?? { parents: [] }, item);
  /** 同宿主 `applyRestructure`（当前场景那一支）；返回新出现问题的对象 → 键。 */
  const applyRestructure = (result: RestructureResult, skip: number | null = null): Map<number, string[]> => {
    const { added, cleared } = trackGroupIssues(groupIssues, result, registry.bundle.layers);
    for (const [object, keys] of added) {
      for (const key of keys) input.unsupportedKeys.add(key);
      if (object !== skip && scene.hasObject(object)) {
        scene.removeObject(object);
        groupHidden.add(object);
      }
    }
    for (const object of cleared) {
      if (!groupHidden.delete(object) || object === skip) continue;
      const layer = registry.bundle.layers.find((item) => item.object === object);
      if (!layer || !state.layers.has(object)) continue;
      const prepared = scene.prepareObjectSync(layer, state);
      if (prepared) scene.installObject(prepared, state);
      else input.reloads.push(`结构变化：对象 ${object} 出组后装不回来（程序没有就绪）`);
    }
    const objects = [...result.changed].filter((object) => object !== skip && !groupIssues.has(object));
    if (objects.length > 0) scene.restructure(objects);
    return added;
  };
  const target: LiveTarget<PreparedObject> = {
    alive: (object) => state.layers.has(object),
    applyDelta: (delta) => registry.applyDelta(delta),
    adopt: ({ fragment }) => {
      const object = fragment.object;
      const only = new Set([object]);
      // 替换（L6）时先取旧排版：状态换对象会清掉它
      const previousText = state.texts.get(object);
      if (registry.bundle.layers.some((layer) => layer.object === object)) registry.replaceObject(fragment);
      else registry.addObject(fragment);
      state.replaceObject(fragment);
      // 组与挂点（L7，同宿主）：别的对象当帧重排；接进来的对象自己用到组内不支持的用法时并进片段的不支持项（`LiveObjects` 不装、上报）
      const result = registry.restructure(state, bones);
      const added = applyRestructure({ changed: new Set([...result.changed, object]), issues: result.issues }, object);
      const own = added.get(object) ?? groupIssues.get(object);
      if (own && fragment.unsupported.length === 0) {
        fragment.unsupported = [...own];
        groupHidden.add(object);
      }
      rebindFragment(state, fragment, input.properties);
      // 关键帧按 id 接回时钟、puppet 先摘旧的（同宿主 `addCompiledObject(replace)`；L5 的壳没有这两样，摘不到什么）
      input.animations?.replaceObjects(only, fragment.animations);
      input.puppets?.remove(only);
      input.puppets?.add(puppetEntry(fragment.layer));
      // 文本（同宿主）：替换一个已有排版的文本层时旧排版先放回状态（旧的运行时在新的装上之前照画、读它），新排版换进状态时才放掉原来那份
      if (previousText && fragment.layer.text) state.setText(object, previousText);
      else if (previousText) releaseTextLayout(previousText);
      let pending: Promise<void> = Promise.resolve();
      if (fragment.layer.text) {
        // 探针的文本准备（`probeTexts.ts`）不留实例：运行中建的文本层另开一套（图集和建场景时排的不是同一套，探针可以接受）
        const owner = (texts ??= new SceneTexts({ reader: input.reader }));
        pending = owner.layoutInCurrent(fragment.layer).then((layout) => {
          if (!layout) return;
          if (state.layers.has(object)) {
            const current = state.texts.get(object);
            state.setText(object, layout);
            if (current && current !== layout) owner.releaseLayout(current);
          } else owner.releaseLayout(layout);
        });
      }
      input.scripts()?.adoptObject?.(fragment);
      return pending;
    },
    gpu: () => true,
    prepareSync: (layer) => scene.prepareObjectSync(layer, state),
    prepare: (layer) => scene.prepareObject(layer, state),
    // 异步备好的对象装上之前进了用到不支持用法的组（L7，同宿主）：不装
    install: (prepared) => {
      if (groupIssues.has(prepared.layer.object)) {
        scene.discardPrepared(prepared);
        groupHidden.add(prepared.layer.object);
      } else scene.installObject(prepared, state);
    },
    discard: (prepared) => scene.discardPrepared(prepared),
    warm: async (layer) => scene.discardPrepared(await scene.prepareObject(layer, state)),
    unsupported: (_object, keys) => {
      for (const key of keys) input.unsupportedKeys.add(key);
    },
    // 单对象重编译的片段带不支持项（L6）：旧的运行时卸掉，这个对象不画
    removeGpu: (object) => scene.removeObject(object),
    reload: (reason) => void input.reloads.push(reason),
    properties: () => Object.fromEntries([...input.properties].map(([key, property]) => [key, property.value])),
  };
  return {
    live: new LiveObjects(
      target,
      (request) => input.session.compileFragment(request),
      { sync: 0, async: 0, unsupported: 0 },
      input.cache,
    ),
    restructure(removed = []) {
      // 删除生效（同宿主 `removeObjectEverywhere` 的登记表一步）：先摘登记表，被删对象的组内问题一起丢
      for (const object of removed) {
        registry.removeObject(object);
        groupIssues.delete(object);
        groupHidden.delete(object);
      }
      input.restructured.count++;
      applyRestructure(registry.restructure(state, bones));
    },
  };
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

/**
 * 计数：就地应用次数、整场重编译记录（含原因）、运行中建层（L5）、交给单对象重编译的次数（L6，`recompiledObjects`）、结构变化当场重排的次数（L7，
 * `restructured`）、单图层重建，以及 `render()` 的 CPU 用时统计。
 */
export function hostStats(host: SceneHost): {
  applied: number;
  recompiled: { reason: string; keys: string[] }[];
  created: SceneHost["stats"]["created"];
  recompiledObjects: number;
  restructured: number;
  rebuilds: { count: number; meanMs: number; maxMs: number };
  frameMs: { mean: number; p95: number };
} {
  const renderer = host.devScene.renderer;
  return {
    applied: host.stats.applied,
    recompiled: host.stats.recompiled.map((item) => ({ ...item, keys: [...item.keys] })),
    created: { ...host.stats.created },
    recompiledObjects: host.stats.recompiledObjects,
    restructured: host.stats.restructured,
    rebuilds: rebuildSummary(renderer?.currentScene?.rebuildStats),
    frameMs: frameStats(renderer?.frameCosts ?? []),
  };
}

/**
 * 按固定 `g_Time` 渲染**当前**场景（含就地改过的状态）并读回、给 SHA-256：与 `renderFrame` 的整场重编译结果逐字节比较，
 * 是「就地 = 重编译」的真机判据（P3a 验收 4）。指针固定在 (0.5, 0.5)；视差同 `renderFrame`，从加载时的场景中心起推进这一帧
 * （帧时间 0），不用渲染器正在用的视差点；抖动按 `time` 现算（P5a 步骤 3），缩放取当前状态的 `general.zoom`（步骤 4）。交给场景的
 * 视差与相机留在当前场景上，渲染器的下一帧照常换回自己的。
 * 给了 `key` 时读回的 RGBA（alpha 置 255）另存成 `<key>.rgba`，经 `chunk` 取（P11b 步骤 5：按区域和 WPE 抓帧比运行中改值后的画面）。
 */
export async function hostRenderFrame(
  host: SceneHost,
  time: number,
  key?: string,
): Promise<{ sha256: string; width: number; height: number }> {
  const renderer = host.devScene.renderer;
  const scene = renderer?.currentScene;
  const state = renderer?.sceneState;
  if (!renderer || !scene || !state) throw new Error("当前没有可渲染的场景");
  // 用户纹理（P11b 步骤 2）：在途的解码先等完（完成时已把来源标进状态，下面的 `sync` 换上），读回的才是确定的画面
  await host.settleUserTextures();
  const device = renderer.device;
  const encoder = device.createCommandEncoder({ label: "probe host frame" });
  // 视差点的单位是场景的正交尺寸（`bundle.general`），没有 bundle 时退回场景目标尺寸
  const general = host.devScene.bundle?.general;
  const { width, height } = general ?? scene;
  // 透视场景（P5d 步骤 2）：按路径起点求相机（同 `renderFrame` 不给 dts），抖动按 `time`；视差点 W = H = 0、不移动对象。
  // 相机对象（P5d 步骤 3）按当前状态选（同渲染器的 `sceneCameraFrame`）；没有 bundle 时没有相机对象
  const perspective = !!general?.perspective;
  const { camera, eye } = sceneCameraFrame({
    cameraLayers: host.devScene.bundle ? cameraObjectLayers(host.devScene.bundle) : [],
    state,
    general: general ?? { width, height, perspectiveOverrideFov: 0 },
    time,
    perspective: perspective
      ? {
          camera: general!.camera ?? { ...DEFAULT_CAMERA, paths: [] },
          path: initialCameraPathState(),
          dt: 0,
          width: scene.width,
          height: scene.height,
        }
      : null,
  });
  scene.setCamera(camera);
  const parallax = advanceParallax(
    initialParallaxState(width, height, perspective),
    parallaxInput(state.general, { pointer: [0.5, 0.5], frametime: 0, width, height, eye }),
  );
  scene.setParallax(drawParallax(parallax, state.general, perspective), state);
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
  if (key !== undefined) stored.set(`${key}.rgba`, rgba);
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

/**
 * 文本层运行中重排的统计（P6b 1e，`GpuScene.textStats`）与每个文本层的当前字段、排版尺寸：给验收量每帧重排的层数与耗时。没有场景时
 * 统计为 null、层为空。
 */
export function hostTexts(host: SceneHost): {
  stats: ReturnType<GpuScene["textStats"]> | null;
  layers: Record<number, { text: string; pointsize: number; size: number[]; compositeSize: number[]; glyphs: number }>;
} {
  const renderer = host.devScene.renderer;
  const state = renderer?.sceneState;
  const layers: ReturnType<typeof hostTexts>["layers"] = {};
  for (const [object, fields] of state?.textFields ?? []) {
    const layout = state?.texts.get(object);
    layers[object] = {
      text: fields.text,
      pointsize: fields.pointsize,
      size: layout ? [...layout.size] : [],
      compositeSize: layout ? [...layout.compositeSize] : [],
      glyphs: (layout?.mesh?.glyphs.length ?? 0) + (layout?.mesh?.colorGlyphs.length ?? 0),
    };
  }
  return { stats: renderer?.currentScene?.textStats() ?? null, layers };
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
  /**
   * 每帧的 16 段频谱（P4e 步骤 4）：`{ left: [16 个], right: [16 个] }`，和 `dts` 等长，第 i 项在第 i + 1 帧步进之前原样写进全部系统共用的
   * 频谱（不经归一化）；某项为 null 时沿用前一帧。回放 WPE 时填抓帧里 CLK 读到的 `g_AudioSpectrum16Left/Right`。不给时全程全 0。
   */
  audio?: (ParticleAudioFrame | null)[];
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
    // 透视场景（P5d 步骤 2）：跟随点的反投影还没接透视相机（没给 `size` 时跟随点恒为 (0, 0)，不算出 NaN），给了 cursors 时报错
    const perspective = !!bundle.general.perspective;
    if (perspective && options.cursors)
      throw new Error("透视场景的 particleTrack 还不支持 cursors（跟随点要按透视相机反投影）");
    // 相机对象（P5d 步骤 3）：跟随点的反投影只认抖动与缩放（`particles/track.ts`），没接相机对象的视图
    if (options.cursors && cameraObjectLayers(bundle).length)
      throw new Error("带相机对象的场景的 particleTrack 还不支持 cursors（跟随点要按相机对象的视图反投影）");
    const size: [number, number] | undefined = perspective ? undefined : [bundle.general.width, bundle.general.height];
    // 光标的裁切（P6c 修复 2）：`fill` 且窗口与场景比例不同时用裁过的 P·V 与窗口指针，同产品渲染器
    const trackCrop =
      options.cursors && size && options.window
        ? fillCropEdges("fill", size[0], size[1], options.window[0], options.window[1])
        : null;
    return particleTrack({
      layers: bundle.layers,
      dts: options.dts,
      times: options.times,
      frames: options.frames,
      passes: options.passes,
      seed: options.seed,
      random: options.random,
      audio: options.audio,
      // 窗口归一化 → 光标下的场景纹理坐标（P5a 收尾，换算放在 dev 里，`particles/track.ts` 只收场景坐标）
      cursors:
        options.cursors && size && (trackCrop ? options.cursors : sceneCursors(options.cursors, size, options.window)),
      cursorCrop: trackCrop ?? undefined,
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
