/**
 * 场景渲染器：持有设备、画布上下文、时钟与帧循环，当前场景（`GpuScene`）可无缝替换。
 *
 * - **铺放**：场景先画进场景分辨率的离屏目标，再按 cover（等比盖满、居中裁切）铺到画布。三屏等宽高比差很多的场景
 *   在 WPE 里怎么处理还没对照过，P1 先统一 cover。HDR 场景的离屏目标是 `rgba16float`，泛光 combine 已截到 [0, 1]，
 *   画布（8 位）上直接按编码值输出（见 `compile/bloom.ts`）。
 * - **帧循环**：`requestAnimationFrame`，默认上限 60 fps（`maxFps`）。`paused` 或 `document.hidden` 时停循环、冻结时钟，
 *   恢复后 `g_Time` 从冻结处继续（见 `clock.ts`）。暂停期间画布尺寸变了会补画一帧（同一时刻），避免空白。
 *   帧时间照 WPE 钳到 `[0.0001, 0.25]`，`g_Time` 累加钳后的值（T2，`FrameClock`）。粒子每个实时帧按帧时间步进一次，
 *   operator 的遍数由 `maxFps` 定（`particlePasses`：1–20 两遍，否则一遍，对应 WPE 的 `fps` 设置，P4a 步骤 4）。
 *   一帧的顺序（P4c 步骤 4）：`sync` → 步进粒子 → 脚本（`beforeFrame`）→ `sync` → 写每帧 uniform → 编码，粒子先于脚本，同 WPE。
 *   声音的排期器（P6a 步骤 1，`stepObjects`）在步进粒子之后、脚本之前，同一个帧时间。视频纹理（P9a 步骤 2，`videos`）的帧号在
 *   帧时钟推进之后、第一次 `sync` 之前加一（`beginFrame`，只在实时帧，补画帧与暂停期间帧号不走），视频的结束回调因此先于脚本；
 *   编码时画到视频纹理才拷帧（`GpuScene` 问 `drawn`）。
 * - **场景频谱**（P4e 步骤 4，`audio/spectrum.ts`）：帧开头、粒子步进之前按宿主给的原始频谱（`audioFrame`）推进一次，补画帧不推进；
 *   粒子读它的 16 段，脚本的音频缓冲在 `beforeFrame` 里从它拷。重编译保留。
 * - **视差**（P5a 步骤 2，`parallax.ts`）：视差点 P 在帧开头、粒子与脚本之前推进一次，脚本之后按当时的开关与 amount 交给
 *   `GpuScene.setParallax`（属性与脚本写 `cameraparallax*` 同帧生效），`g_ParallaxPosition` 随每帧 uniform 写。P 归渲染器：
 *   整场重编译保留，新场景回到场景中心（见 `load`）。
 * - **抖动**（P5a 步骤 3，`shake.ts`）：帧开头、推进视差点之前，按本帧的 `g_Time` 算 eye 偏移 s，同一个 s 作视差点的 eye；粒子步进
 *   之后、脚本之前才交给 `GpuScene.setCamera`，所以粒子模拟用的是上一帧的 s（同 WPE，见 `render`）。渲染器不存 s。
 * - **缩放**（P5a 步骤 4）：`general.zoom` 和 s 同一时刻取（脚本之前），随 s 一起交给 `setCamera`，脚本写 `zoom` 下一帧生效。
 * - **透视相机**（P5d 步骤 2，`camera.ts`）：透视场景按画布尺寸渲染（场景目标取 `fullResolution`，已定 6），上屏铺满、壁纸样式
 *   不起作用（铺放与指针按 `stretch`）。帧开头按路径状态求来源姿态并推进（补画帧 dt 0，不推进），加三维抖动、算 V、P，粒子步进之后
 *   交给 `setCamera`（同抖动的时机）；视差点的 eye 是透视相机的 eye.xy，W = H = 0，不移动对象。路径状态归渲染器，整场重编译保留
 *   （同视差点）。画布分辨率变了（和建场景时不同）且稳定 300 ms 后调 `onRenderSizeChange`，宿主整场重新加载。
 * - **替换**：`load(bundle)` 在同一设备上先建好新场景，再在帧间换掉旧的并释放；时钟不重置。
 * - **失败**：运行期出现未捕获的校验错误或一帧的 CPU 部分抛错时停止渲染、经 `onError` 交出原因；设备丢失（非主动销毁）经 `onLost` 交出。
 */
import { SceneSpectrum } from "../audio/spectrum";
import type { SceneBinding } from "../compile/bindings";
import type { SceneBundle } from "../compile/bundle";
import type { SceneScalar } from "../compile/model";
import { particlePasses } from "../particles/system";
import type { ParticleScriptTarget } from "../script/api";
import type { TextRelayouter } from "../text/host";
import type { TextLayout } from "../text/layout";
import { TIME_WRAP_SECONDS } from "../sceneTime";
import type { VideoSink } from "../video/sceneVideos";
import {
  BLIT_SAMPLER,
  createBlitBindGroup,
  createBlitPipeline,
  encodeBlit,
  PLACEMENT_BYTES,
  placementUniform,
  TILE_SAMPLER,
} from "./blit";
import { FrameClock, FrameThrottle, PausableClock } from "./clock";
import { acquireGpu, type Gpu, type GpuAdapterInfo } from "./device";
import { oneLine, reasonsOf, SceneRenderError } from "./errors";
import {
  canvasSize,
  sceneCursor,
  scenePlacement,
  scenePointer,
  sceneTargetSize,
  type ScenePlacement,
  type SceneStyle,
} from "./layout";
import { advanceParallax, drawParallax, initialParallaxState, parallaxInput, type ParallaxState } from "./parallax";
import { initialCameraPathState, perspectiveCamera, stepCameraSource, type CameraPathState } from "./camera";
import { DEFAULT_CAMERA, type SceneCameraJson } from "../compile/camera";
import { GpuScene, type SceneCamera } from "./scene";
import { shakeOffset } from "./shake";
import { SceneState } from "./state";
import { daytimeOf } from "./uniforms";

/**
 * 帧循环里核对画布尺寸的间隔：DPR 变化（换显示器、改系统缩放）不触发 ResizeObserver，这样最多晚这么久跟上。
 * 父页面的 CSS transform 跨不进 iframe，这里量不到，由父页面量好经 `setDisplayScale` 交来。
 */
const SIZE_CHECK_INTERVAL_MS = 250;

/** 透视场景的画布分辨率变了之后，稳定这么久才请宿主重新加载（P5d 步骤 2）：拖动窗口边框时不反复重建。 */
export const RENDER_SIZE_SETTLE_MS = 300;

function validDisplayScale(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export interface SceneRendererOptions {
  /** 帧率上限；≤ 0 不限（跟随 rAF）。默认 60。 */
  maxFps?: number;
  /** 初始显示缩放（见 `setDisplayScale`），默认 1。建渲染器时就带上，免得先按原尺寸建一张大画布再缩。 */
  displayScale?: number;
  /** 运行期失败（未捕获的校验错误等），渲染已停止。 */
  onError?: (reasons: string[]) => void;
  /** 设备丢失（非 `destroy()` 引起），渲染已停止；调用方可以重建渲染器。 */
  onLost?: (reasons: string[]) => void;
  /**
   * 每个实际渲染帧在粒子步进之后、第二次状态同步之前执行（P4c 步骤 4，见 `render`）；暂停时不执行。`spectrum` 是这一帧已推进的场景
   * 频谱（P4e 步骤 4，同 `SceneRenderer.spectrum`）：脚本的音频缓冲在这里从它拷。
   */
  beforeFrame?: (dt: number, spectrum: SceneSpectrum) => void;
  /**
   * 音频的原始频谱（P4e 步骤 4）：每帧开头取一次，交给场景频谱推进（`SceneSpectrum.advance`）。返回 Hub 最近一次推来的 128 个值（左 64 +
   * 右 64），还没收到时 null。不给时当 null（频谱全 0）。
   */
  audioFrame?: () => ArrayLike<number> | null;
  /**
   * 不画东西的对象的每帧更新（P6a 步骤 1：声音的排期器）：每个实时帧在粒子步进之后、脚本（`beforeFrame`）之前，用同一个钳过的
   * 帧时间（WPE 在对象更新里走声音计时器，rea-p6a-sound.md 2.3）。补画帧（帧时间 0）与暂停时不执行，计时自然冻结。
   */
  stepObjects?: (dt: number) => void;
  /**
   * 视频纹理的帧来源（P9a 步骤 2，宿主的 `SceneVideos`）：每个实时帧开头 `beginFrame`（帧时钟推进之后、粒子步进之前；补画帧不调），
   * 换上的每个场景都交给 `GpuScene.setVideoSink`，编码时画到视频纹理才问 `drawn`。缺省时视频纹理保持全 0。
   */
  videos?: VideoSink;
  /**
   * 透视场景按画布尺寸渲染（P5d 步骤 2，已定 6）：画布分辨率（`fullResolution`）和建场景时不同、稳定 `RENDER_SIZE_SETTLE_MS` 之后调一次，
   * 宿主走整场重新加载（场景目标、深度、快照、泛光、fullscreen 合成 RT 都跟尺寸有关，不写 resize）。正交场景不调。
   */
  onRenderSizeChange?: () => void;
}

export interface SceneLoadOptions {
  /** dev 强制渲染（D4）：不因 `bundle.unsupported` 拒绝，渲染器自查仍然生效。 */
  ignoreUnsupported?: boolean;
  /** 新状态建好后、首帧绘制前同步执行。 */
  beforeFirstFrame?: (state: SceneState) => void;
  /**
   * 文本层的排版结果（P6b 1d，`objects` 下标 → `TextLayout`）：宿主在加载前排好（`text/host.ts` 的 `SceneTexts.prepare`），原样交给
   * `GpuScene.build`。bundle 里有文本层而没给时整场画不了（`render:text-layout`）。
   */
  texts?: ReadonlyMap<number, TextLayout>;
  /**
   * 运行中重排（P6b 1e）：宿主 `SceneTexts.relayouter()`，绑定排出 `texts` 的那次加载，原样交给 `GpuScene.build`。不给时文本字段变了也不重排。
   */
  relayout?: TextRelayouter;
}

/** 一条就地写：绑定 + 新值（宿主按 `planApply` 挑出来）。 */
export interface BindingWrite {
  binding: SceneBinding;
  value: SceneScalar;
}

export class SceneRenderer {
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly clock = new PausableClock();
  private readonly throttle: FrameThrottle;
  private readonly blitPipeline: GPURenderPipeline;
  private readonly blitSampler: GPUSampler;
  /** `tile` 用：纹理坐标超出 0…1 的部分重复。 */
  private readonly tileSampler: GPUSampler;
  private readonly placementBuffer: GPUBuffer;
  private readonly observer: ResizeObserver | null;
  private scene: GpuScene | null = null;
  /** 当前场景的 CPU 侧状态（就地写的落点，`GpuScene.sync` 每帧取脏项）。 */
  private state: SceneState | null = null;
  /** 上屏的 bind group，按场景目标的视图取：清屏可能关掉的场景有两张目标，每张一个（L11）。换场景或样式时清空。 */
  private readonly blitBindGroups = new Map<GPUTextureView, GPUBindGroup>();
  private style: SceneStyle = "fill";
  /** 留白的颜色（0…1 的 RGB）。 */
  private background: [number, number, number] = [0, 0, 0];
  private placement: ScenePlacement = { rect: [0, 0, 1, 1], offset: [0, 0], scale: [1, 1] };
  private placementKey = "";
  /** 父页面把 iframe 缩小显示的比例（iframe 里量不到 transform），画布按它缩到实际显示大小。 */
  private displayScale = 1;
  /** 一个布局 CSS 像素对多少画布像素（`canvasSize`），随画布尺寸一起更新；`center` 样式用。 */
  private pixelRatio = 1;
  /** 显示缩放为 1 时的画布尺寸：脚本的 `engine.screenResolution`，预览缩小显示时也和桌面一致。 */
  private fullResolution: [number, number] = [1, 1];
  /** `g_PointerPosition`：光标在画布上的归一化坐标按样式换算后的值（原点左上、y 向下，PLAN P2a「内置 uniform」）。 */
  private pointer: [number, number] = [0.5, 0.5];
  private pointerLast: [number, number] = [0.5, 0.5];
  /**
   * 最近一次 `setPointer` 收到的画布原始坐标（0…1，左上原点），没收到过时为 null。控制点跟随指针用的 `cursor`
   * （`sceneCursor`）每帧按当前样式与铺放从它现算（P4c 步骤 2），改样式、改尺寸后下一帧就对，不用等下一次 `pointermove`。
   * 开场由父页面交一次真实光标（P5a 收尾，宿主 `scenePointerFeed`），之后只在宿主收到事件时更新（预览是光标在 iframe 上时，
   * 桌面是鼠标转发时），之外保持最后的值；WPE 每帧读全局光标、窗口外也跟踪，这点差别不处理。
   */
  private canvasPointer: [number, number] | null = null;
  /** `g_Time` / `g_Frametime`：钳过的帧时间与它的累加（T2）。换场景不重置。 */
  private readonly frameClock = new FrameClock();
  /**
   * 场景频谱（P4e 步骤 4，`audio/spectrum.ts`，rea-p4e-audio.md 3.3）：每个实时帧在粒子步进之前按 `audioFrame` 推进一次，补画帧（帧时间
   * 0）不推进。粒子树读它的 `L16` / `R16`（建场景时交给 `GpuScene`），脚本的音频缓冲每帧从它拷（`beforeFrame`）。归渲染器所有：整场
   * 重编译保留（同视差点；WPE 的状态在场景窗口上，改属性不重建），新场景是新页面、新渲染器，从全 0 开始。
   */
  readonly spectrum = new SceneSpectrum();
  /**
   * 视差点 P 与 `g_ParallaxPosition`（P5a 步骤 2）。整场重编译保留（同一渲染器上第二次起的 `load`），新场景回到场景中心
   * （渲染器的第一次 `load`：宿主一个页面只放一张场景，换壁纸是新页面、新渲染器；设备丢失或退回后重建渲染器，P 也随之回到中心）。
   */
  private parallax: ParallaxState = initialParallaxState(1, 1);
  /** 当前场景的正交尺寸 W、H（`SceneGeneral.width/height`，不是可能被缩小的渲染目标）：视差点的单位，加载时取。透视场景是 (0, 0)。 */
  private projection: [number, number] = [1, 1];
  /** 当前场景是透视场景（P5d 步骤 2，`SceneGeneral.perspective`），加载时取。 */
  private perspective = false;
  /** 透视场景的基准相机与路径（`SceneGeneral.camera`），加载时取；正交场景为 null。 */
  private camera: SceneCameraJson | null = null;
  /**
   * 透视相机的路径状态（P5d 步骤 2，`camera.ts`）：每个实时帧求值后推进。整场重编译保留（同视差点：WPE 改属性不重建场景），新场景从头。
   */
  private cameraPath: CameraPathState = initialCameraPathState();
  /** 透视场景建场景时的画布分辨率（`GpuScene.build` 的 `size`）；正交场景为 null。 */
  private renderSize: [number, number] | null = null;
  /** 分辨率变化的去抖计时器（`RENDER_SIZE_SETTLE_MS`）与它在等的那个分辨率。 */
  private renderSizeTimer: ReturnType<typeof setTimeout> | null = null;
  private renderSizeKey = "";
  private paused = false;
  private failed = false;
  private lost = false;
  private destroyed = false;
  private raf = 0;
  /** 上次按显示尺寸核对画布的时刻（帧循环里节流核对，见 `resize`）。 */
  private sizeCheckedAt = 0;
  private loadSerial = 0;
  /** Tint 的非错误消息（warning / info），调用方记日志用。 */
  readonly warnings: string[] = [];
  /** 最近 600 帧 `render()` 的 CPU 用时（毫秒）；dev 探针统计均值 / p95。 */
  readonly frameCosts: number[] = [];

  private constructor(
    private readonly gpu: Gpu,
    private readonly canvas: HTMLCanvasElement,
    private readonly options: SceneRendererOptions,
  ) {
    const device = gpu.device;
    this.throttle = new FrameThrottle(options.maxFps ?? 60);
    if (validDisplayScale(options.displayScale)) this.displayScale = options.displayScale;
    const context = canvas.getContext("webgpu");
    if (!context) throw new SceneRenderError(["webgpu:canvas-context"]);
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: this.format, alphaMode: "opaque" });
    // 上屏的着色器、采样器参数与 pass 在 `blit.ts`，dev 探针读回画布时用同一份
    this.blitPipeline = createBlitPipeline(device, this.format);
    this.blitSampler = device.createSampler(BLIT_SAMPLER);
    this.tileSampler = device.createSampler(TILE_SAMPLER);
    this.placementBuffer = device.createBuffer({
      size: PLACEMENT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.onuncapturederror = (event) => this.fail([`webgpu:validation:${oneLine(event.error.message)}`]);
    void device.lost.then((info) => {
      if (this.destroyed || info.reason === "destroyed") return;
      this.lost = true;
      this.stop();
      this.options.onLost?.([`webgpu:device-lost:${info.reason}:${oneLine(info.message)}`]);
    });
    this.observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.resize());
    this.observer?.observe(canvas);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.resize();
  }

  /** 取设备并在画布上建 WebGPU 上下文；失败抛 `SceneRenderError`。 */
  static async create(canvas: HTMLCanvasElement, options: SceneRendererOptions = {}): Promise<SceneRenderer> {
    const gpu = await acquireGpu();
    try {
      return new SceneRenderer(gpu, canvas, options);
    } catch (error) {
      gpu.device.destroy();
      throw error instanceof SceneRenderError
        ? error
        : new SceneRenderError([`webgpu:context:${oneLine(String(error))}`]);
    }
  }

  get adapterInfo(): GpuAdapterInfo {
    return this.gpu.info;
  }

  get device(): GPUDevice {
    return this.gpu.device;
  }

  /** 当前场景的离屏目标与渲染目标类显存估算（日志用）；没有场景为 null。 */
  get sceneStats(): { width: number; height: number; format: GPUTextureFormat; targetBytes: number } | null {
    const scene = this.scene;
    return scene
      ? { width: scene.width, height: scene.height, format: scene.format, targetBytes: scene.targetBytes }
      : null;
  }

  /** 当前场景的 CPU 侧状态；没有场景为 null。3b 的脚本写回与 dev 探针都用它。 */
  get sceneState(): SceneState | null {
    return this.state;
  }

  /**
   * 脚本的 `engine.screenResolution`：按显示缩放为 1 算的画布尺寸（布局 × DPR，超上限等比缩）。预览缩小显示时画布变小，
   * 脚本看到的分辨率仍与桌面一致；桌面上就是画布尺寸。
   */
  get screenResolution(): [number, number] {
    return this.fullResolution;
  }

  /** 最近一帧的 `g_Time`（未回绕）：脚本的 `engine.runtime`。 */
  get runtimeSeconds(): number {
    return this.frameClock.time;
  }

  /** 最近一帧的 `g_Frametime`：脚本的 `engine.frametime`。 */
  get frameSeconds(): number {
    return this.frameClock.frametime;
  }

  /** 当前 GPU 场景；dev 探针按固定 `g_Time` 读回时用。 */
  get currentScene(): GpuScene | null {
    return this.scene;
  }

  /** 粒子层脚本方法的落点（P4f 步骤 3，`GpuScene.particleScript`）；没有场景或不是粒子层时为 null。 */
  particleScript(object: number): ParticleScriptTarget | null {
    return this.scene?.particleScript(object) ?? null;
  }

  /**
   * 就地应用一批绑定写入；需要重编译时返回 false（调用方整场重编译）。
   * 写之前先问状态能不能做：打开带不支持项的 effect、切换冻结的图层、打开没有泛光链的场景不能（`needsRecompile`），
   * 做不了就一条都不写。
   * 这里不画：暂停时由宿主在脚本的属性回调之后调 `redraw`，回调的写入才能进同一帧。
   */
  applyBindings(writes: readonly BindingWrite[]): boolean {
    const state = this.state;
    if (!state || !this.scene || this.destroyed || this.lost || this.failed) return false;
    if (writes.some((write) => state.needsRecompile(write.binding, write.value))) return false;
    for (const write of writes) state.write(write.binding, write.value);
    return true;
  }

  /** 循环不跑时补画一帧（同 resize）：画面立即反映就地写，`g_Time` 不动、脚本不跑。循环在跑时什么都不做。 */
  redraw(): void {
    if (!this.shouldRun) this.render();
  }

  /**
   * 建好新场景后替换当前场景，画出第一帧并等 GPU 完成后返回。失败抛 `SceneRenderError`，当前场景保持不变。
   * 并发调用时只有最后一次生效，被取代的调用抛 `AbortError`。
   */
  async load(bundle: SceneBundle, options: SceneLoadOptions = {}): Promise<void> {
    if (this.destroyed) throw new DOMException("渲染器已销毁", "AbortError");
    if (this.lost) throw new SceneRenderError(["webgpu:device-lost"]);
    const serial = ++this.loadSerial;
    const state = SceneState.fromBundle(bundle);
    // 透视场景按画布尺寸渲染（P5d 步骤 2，已定 6）：场景目标取显示缩放为 1 的画布尺寸，铺放与指针按 `stretch`
    const perspective = !!bundle.general.perspective;
    const size: [number, number] | undefined = perspective ? [...this.fullResolution] : undefined;
    // 加载时的控制点更新和预热用加载时刻的 cursor（WPE 加载时也读当时的指针，rea-p4c-sim.md 1.3、1.7）：按新场景的尺寸现算
    // 一次铺放，尺寸取法同 `GpuScene.width/height`，和之后 `syncPlacement` 算的一致
    const [sceneWidth, sceneHeight] = sceneTargetSize(
      size?.[0] ?? bundle.general.width,
      size?.[1] ?? bundle.general.height,
      this.gpu.device.limits.maxTextureDimension2D,
    );
    const placementStyle: SceneStyle = perspective ? "stretch" : this.style;
    const placement = scenePlacement(
      placementStyle,
      sceneWidth,
      sceneHeight,
      this.canvas.width,
      this.canvas.height,
      this.pixelRatio,
    );
    // 遍数与 rope 读的 `fps`（P4d 步骤 1，rea-p4d-rope.md 1.2）都取帧上限，对应 WPE 的 `fps` 设置
    const fps = this.options.maxFps ?? 60;
    const scene = await GpuScene.build(this.gpu.device, bundle, state, this.gpu.features, this.warnings, {
      ignoreUnsupported: options.ignoreUnsupported,
      particles: {
        passes: particlePasses(fps),
        fps,
        cursor: this.cursorOf(placement, placementStyle),
        // 粒子读场景频谱的 16 段（P4e 步骤 4）；预热在这里跑，首次加载时频谱是 0（rea-p4e-audio.md 3.5）
        audio: { left: this.spectrum.L16, right: this.spectrum.R16 },
      },
      texts: options.texts,
      relayout: options.relayout,
      size,
    });
    if (this.destroyed || serial !== this.loadSerial) {
      scene.destroy();
      throw new DOMException("已被新的场景取代", "AbortError");
    }
    // 视频纹理（P9a）：画第一帧之前接上，第一帧就能问 `drawn`
    scene.setVideoSink(this.options.videos ?? null);
    const old = this.scene;
    // 重编译：粒子层沿用旧场景的脚本暂停 / 停止（P4f 步骤 3），在重放脚本写入、画第一帧之前
    if (old) scene.adoptParticleScripts(old);
    this.scene = scene;
    this.state = state;
    this.projection = [bundle.general.width, bundle.general.height];
    this.perspective = perspective;
    this.camera = perspective ? (bundle.general.camera ?? { ...DEFAULT_CAMERA, paths: [] }) : null;
    this.renderSize = size ?? null;
    // 视差点：新场景回到场景中心（WPE 加载末尾写初值，rea-p5-camera.md 6.2；透视场景是 (0, 0)），重编译（换下的是同一张场景）保留。
    // 透视相机的路径状态同样（P5d 步骤 2）
    if (!old) {
      this.parallax = initialParallaxState(bundle.general.width, bundle.general.height, perspective);
      this.cameraPath = initialCameraPathState();
    }
    this.blitBindGroups.clear();
    this.placementKey = "";
    // 场景换上之前收到的指针（开场初值早于第一次加载，P5a 收尾）：没有场景时 `setPointer` 只能原样记下，这里按新场景的铺放
    // 换成 `g_PointerPosition`，第一帧与视差点就用它；`pointerLast` 不动（同 `setPointer` 的规则）。重编译时同一张场景换算结果不变
    const canvasPointer = this.canvasPointer;
    if (canvasPointer) {
      this.syncPlacement(scene);
      this.pointer = scenePointer(
        this.placementStyle,
        this.placement,
        this.canvas.width,
        this.canvas.height,
        ...canvasPointer,
      );
    }
    options.beforeFirstFrame?.(state);
    old?.destroy();
    this.failed = false;
    this.render(true);
    await this.gpu.device.queue.onSubmittedWorkDone();
    if (this.failed) throw new SceneRenderError(["webgpu:first-frame"]);
    this.sync();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.sync();
  }

  /**
   * 关掉场景频谱（P4e 步骤 4，`SceneSpectrum.disable`）：宿主的音频订阅被拒（没声明 `supportsaudioprocessing`、非 Windows）时调，频谱
   * 清零并保持全 0。
   */
  disableAudio(): void {
    this.spectrum.disable();
  }

  /**
   * 画布上的指针位置（0…1，左上为原点、y 向下），按样式换算成 `g_PointerPosition`（见 `scenePointer`）；原始坐标另记下，
   * 控制点的 `cursor` 每帧从它现算（`canvasPointer`）。暂停时照常记，不画；恢复后的第一帧用最新值（WPE 暂停时指针冻结、
   * 恢复后读当时的光标，效果相同）。
   */
  setPointer(x: number, y: number): void {
    this.canvasPointer = [x, y];
    this.pointerLast = this.pointer;
    if (!this.scene) {
      this.pointer = [x, y];
      return;
    }
    this.syncPlacement(this.scene);
    this.pointer = scenePointer(this.placementStyle, this.placement, this.canvas.width, this.canvas.height, x, y);
  }

  /** 壁纸样式：只影响上屏，场景本身不重画。 */
  setStyle(style: SceneStyle): void {
    if (style === this.style) return;
    this.style = style;
    this.blitBindGroups.clear();
    this.redraw();
  }

  setBackground(color: [number, number, number]): void {
    this.background = color;
    this.redraw();
  }

  /**
   * 父页面把 iframe 缩小显示的比例（`getBoundingClientRect` ÷ 布局尺寸，父页面量）。画布按「布局 × DPR × 它」定尺寸，
   * 不再按布局尺寸渲染只显示一小块的大画面。非正数、非有限值不理。
   */
  setDisplayScale(scale: number): void {
    if (!validDisplayScale(scale) || scale === this.displayScale) return;
    this.displayScale = scale;
    this.resize();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    if (this.renderSizeTimer !== null) clearTimeout(this.renderSizeTimer);
    this.renderSizeTimer = null;
    this.observer?.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.scene?.destroy();
    this.scene = null;
    this.state = null;
    this.blitBindGroups.clear();
    try {
      this.context.unconfigure();
    } catch {
      // 画布已脱离文档时 unconfigure 可能抛错，设备随后销毁即可
    }
    this.gpu.device.destroy();
  }

  private readonly onVisibility = () => this.sync();

  /** 铺放与指针用的样式：透视场景铺满（`stretch`，壁纸样式不起作用，P5d 步骤 2），正交场景按壁纸样式。 */
  private get placementStyle(): SceneStyle {
    return this.perspective ? "stretch" : this.style;
  }

  private get shouldRun(): boolean {
    return !this.destroyed && !this.lost && !this.failed && !this.paused && !document.hidden && this.scene !== null;
  }

  /** 按 paused / hidden 启停循环与时钟。 */
  private sync(): void {
    if (this.shouldRun) {
      this.clock.resume();
      if (!this.raf) {
        this.throttle.reset();
        this.raf = requestAnimationFrame(this.frame);
      }
    } else this.stop();
  }

  private stop(): void {
    this.clock.pause();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly frame = (now: number) => {
    this.raf = 0;
    if (!this.shouldRun) return;
    this.raf = requestAnimationFrame(this.frame);
    if (!this.throttle.ready(now)) return;
    // DPR 变化不触发 ResizeObserver，帧循环里定期核对；父页面的缩放由它量好经 setDisplayScale 交来
    if (now - this.sizeCheckedAt >= SIZE_CHECK_INTERVAL_MS) {
      this.sizeCheckedAt = now;
      this.resize();
    }
    this.render();
  };

  private fail(reasons: string[]): void {
    if (this.destroyed || this.failed) return;
    this.failed = true;
    this.stop();
    this.options.onError?.(reasons);
  }

  /**
   * 画布像素尺寸 = 布局尺寸 × DPR × 显示缩放，超上限时保持宽高比地缩（`canvasSize`）；变了就在暂停时补画一帧。
   * `getBoundingClientRect` 在 iframe 里量到的就是布局尺寸：预览画布的 `scale` 加在父页面的 iframe 元素上，
   * 跨不进来，所以显示缩放只能由父页面交来（`setDisplayScale`）。
   */
  private resize(): void {
    if (this.destroyed) return;
    const dpr = window.devicePixelRatio || 1;
    const max = this.gpu.device.limits.maxTextureDimension2D;
    const rect = this.canvas.getBoundingClientRect();
    const full = canvasSize(rect.width, rect.height, dpr, 1, max);
    this.fullResolution = [full.width, full.height];
    this.checkRenderSize();
    const { width, height, pixelRatio } =
      this.displayScale === 1 ? full : canvasSize(rect.width, rect.height, dpr, this.displayScale, max);
    const sized = this.canvas.width === width && this.canvas.height === height;
    if (sized && this.pixelRatio === pixelRatio) return;
    this.pixelRatio = pixelRatio;
    // 同值赋给 width / height 也会重置画布，只在真变了时赋
    if (!sized) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (this.scene && !this.shouldRun) this.render();
  }

  /**
   * 透视场景的场景目标按画布尺寸建（P5d 步骤 2）：`fullResolution` 和建场景时不同就（重新）开始 `RENDER_SIZE_SETTLE_MS` 的去抖，到点时
   * 仍不同才调一次 `onRenderSizeChange`；回到原尺寸时取消。正交场景、没有场景时不做。WPE 只重建 RT、粒子接着跑，我们整场重新加载、
   * 粒子重新预热，记为已知差异。
   */
  private checkRenderSize(): void {
    const differs = () => {
      const size = this.renderSize;
      return (
        this.perspective && size !== null && (size[0] !== this.fullResolution[0] || size[1] !== this.fullResolution[1])
      );
    };
    if (this.destroyed || !differs()) {
      if (this.renderSizeTimer !== null) clearTimeout(this.renderSizeTimer);
      this.renderSizeTimer = null;
      return;
    }
    // 尺寸还在变：从最后一次变化起重新计时
    const key = this.fullResolution.join("x");
    if (this.renderSizeTimer !== null && key === this.renderSizeKey) return;
    if (this.renderSizeTimer !== null) clearTimeout(this.renderSizeTimer);
    this.renderSizeKey = key;
    this.renderSizeTimer = setTimeout(() => {
      this.renderSizeTimer = null;
      if (!this.destroyed && differs()) this.options.onRenderSizeChange?.();
    }, RENDER_SIZE_SETTLE_MS);
  }

  private blitBindGroup(view: GPUTextureView): GPUBindGroup {
    let group = this.blitBindGroups.get(view);
    if (!group) {
      group = createBlitBindGroup(
        this.gpu.device,
        this.blitPipeline,
        this.placementBuffer,
        view,
        this.placementStyle === "tile" ? this.tileSampler : this.blitSampler,
      );
      this.blitBindGroups.set(view, group);
    }
    return group;
  }

  /**
   * 场景、画布或样式变了才重算。中心样式按「画布像素 / 布局 CSS 像素」换算（DPR × 显示缩放，超上限再乘缩小比例），
   * 所以键里也有它：一个场景像素对一个布局 CSS 像素，预览缩小显示时构图与桌面相同。
   */
  private syncPlacement(scene: GpuScene): void {
    const ratio = this.pixelRatio;
    const style = this.placementStyle;
    const key = `${style}:${scene.width}x${scene.height}@${this.canvas.width}x${this.canvas.height}@${ratio}`;
    if (key === this.placementKey) return;
    this.placementKey = key;
    this.placement = scenePlacement(style, scene.width, scene.height, this.canvas.width, this.canvas.height, ratio);
    this.gpu.device.queue.writeBuffer(this.placementBuffer, 0, placementUniform(this.placement));
  }

  /** 光标下的场景纹理坐标（`sceneCursor`，P4c 步骤 2）：按当前样式与给定铺放从 `canvasPointer` 现算；没收到过指针时取场景中心。 */
  private cursorOf(placement: ScenePlacement, style: SceneStyle = this.placementStyle): [number, number] {
    const pointer = this.canvasPointer;
    if (!pointer) return [0.5, 0.5];
    return sceneCursor(style, placement, this.canvas.width, this.canvas.height, pointer[0], pointer[1]);
  }

  private render(runScripts = false): void {
    const scene = this.scene;
    const state = this.state;
    if (!scene || !state || this.destroyed || this.lost || this.failed) return;
    const started = performance.now();
    const device = this.gpu.device;
    this.syncPlacement(scene);
    // 实时帧：时间前进、脚本与粒子走一帧；其余是补画（同一时刻），帧时间为 0
    const live = !this.paused && !document.hidden && (runScripts || this.shouldRun);
    if (live) this.frameClock.advance(this.clock.seconds());
    else this.frameClock.hold();
    // 视频纹理（P9a）：实时帧开头帧号加一，按「30 帧没画到」暂停空闲的视频，并判定绕回 / 结束：结束回调要在这一帧的脚本之前
    // （p9-REPORT「时钟、循环」），所以在粒子步进之前。补画帧不调，暂停期间帧号不走（WPE 的帧号每个渲染帧加一，rea-p9-video 第 4 节）。
    // 同声音在 try 外：视频的问题不让画面退回
    if (live) this.options.videos?.beginFrame();
    const { time, frametime } = this.frameClock;
    const wrapped = time % TIME_WRAP_SECONDS;
    // 每帧现算（`syncPlacement` 之后）：改样式、改尺寸不经 `setPointer` 也跟上
    const cursor = this.cursorOf(this.placement);
    const [width, height] = this.projection;
    // 抖动（P5a 步骤 3）：帧开头、视差点之前，用本帧的 `g_Time` 与脚本之前的字段算 eye 偏移 s（WPE 更新相机时算，在 lookAt 与
    // 视差点之前，脚本之后才跑，rea-p5-camera.md 第 5 节；脚本写 `camerashake*` 下一帧才生效）。交给场景要等粒子步进之后，见下。
    // 补画帧时间不变，s 也不变。缩放（P5a 步骤 4）同一时刻取：WPE 在相机更新时读 `zoom`，同在脚本之前（p3-script-REPORT L4）
    // 透视场景（P5d 步骤 2）：同一时刻按路径状态求来源姿态并推进（补画帧 dt 0，不推进），加三维抖动、算 V、P（宽高比取场景目标）
    let camera: SceneCamera;
    let eye: readonly [number, number];
    if (this.perspective) {
      const { pose, next } = stepCameraSource(this.camera!, this.cameraPath, frametime);
      this.cameraPath = next;
      const frame = perspectiveCamera({
        pose,
        fields: state.general,
        time: wrapped,
        width: scene.width,
        height: scene.height,
      });
      camera = { kind: "perspective", frame };
      eye = [frame.eye[0], frame.eye[1]];
    } else {
      const shake = shakeOffset(state.general, wrapped, height);
      camera = { shake, zoom: state.general.zoom };
      eye = shake;
    }
    // 视差点（P5a 步骤 2）：帧开头、粒子与脚本之前推进一次，用本帧的 `g_PointerPosition` 与帧时间（补画帧为 0，k 也是 0）；
    // 目标点的 eye.xy 就是 s（步骤 3），透视场景是透视相机的 eye.xy（W = H = 0）。开关关着时 P 与 `g_ParallaxPosition` 都不动
    this.parallax = advanceParallax(
      this.parallax,
      parallaxInput(state.general, { pointer: this.pointer, frametime, width, height, eye }),
    );
    // 场景频谱（P4e 步骤 4）：帧开头、粒子步进之前推进一次（WPE 的音频段紧挨在帧函数之前，rea-p4e-audio.md 3.5），粒子与脚本这一帧
    // 读同一份；补画帧帧时间为 0，不推进
    this.spectrum.advance(this.options.audioFrame?.() ?? null, frametime);
    // 粒子先于脚本（P4c 步骤 4）：WPE 一帧里先模拟粒子、后跑脚本，模拟用的对象变换是本帧脚本运行之前的（依据见
    // `GpuScene.stepParticles`）。步进之前先 `sync`：两帧之间写进状态的属性改值（`instanceoverride` 等）这一帧就进模拟器。
    // 补画帧帧时间为 0，`stepParticles` 只记 cursor 就返回
    try {
      scene.sync(state);
      scene.stepParticles(frametime, wrapped, state, cursor);
    } catch (error) {
      this.fail(reasonsOf(error, "render:frame"));
      return;
    }
    // 本帧的 s 在粒子步进之后才交给场景：WPE 一帧里先对对象调更新（粒子模拟在这里），之后才选相机来源、加抖动、算 lookAt
    // （rea-p5-camera.md 的帧顺序，`FUN_1401891a0`），所以模拟时的指针反投影用的是上一帧的视图（带上一帧的 s、不带视差），指针是当帧的。
    // 实测 `p5a-shakepar` 第 119、120 帧：跟随指针的新生粒子按「当帧指针 + 上一帧 s」误差 0，按当帧 s 差 0.3 像素左右。加载后第一帧
    // 的模拟用加载时的相机（s 为 0），同预热。绘制、`g_EyePosition`、视差点用当帧的 s（实测都对）：第一次 `sync` 里新建的 draw 用的是
    // 旧相机，脚本之后的 `setParallax` 因相机变了整体重写。缩放随同一个相机交（步骤 4）：模拟的反投影用上一帧的 zoom，绘制用当帧的
    // （静态缩放看不出先后，按读码与抖动的实测实现）
    scene.setCamera(camera);
    // 声音（P6a 步骤 1）：粒子之后、脚本之前；同脚本在 try 外，声音的问题不让画面退回
    if (live) this.options.stepObjects?.(frametime);
    // 脚本在 try 外（同以前）：脚本自己的错误不走 `render:frame` 退回
    if (live) this.options.beforeFrame?.(frametime, this.spectrum);
    const encoder = device.createCommandEncoder({ label: "scene frame" });
    try {
      // 绘制用的视差取脚本之后的开关与 amount（WPE 绘制时才读，rea-p5-camera.md 6.3）：脚本写 `cameraparallax*` 同帧生效
      // 透视场景不移动对象（rea-p5-camera 6.1，P5d 步骤 2）
      scene.setParallax(drawParallax(this.parallax, state.general, this.perspective), state);
      // 脚本写回的状态再刷进 uniform 块 / 可见性 / 泛光链，再写每帧内置量（P3a、P4a）
      scene.sync(state);
      scene.update(
        {
          time: wrapped,
          frametime,
          daytime: daytimeOf(new Date()),
          pointer: this.pointer,
          pointerLast: this.pointerLast,
          cursor,
          parallax: this.parallax.position,
        },
        state,
      );
      scene.encode(encoder, state);
    } catch (error) {
      // 抛出去没人接：下一帧已排好，每帧再抛一次，画面停住也不退回
      this.fail(reasonsOf(error, "render:frame"));
      return;
    }
    this.pointerLast = this.pointer;
    // 留白：整屏清成背景色，再把场景画进铺放矩形（`blit.ts`）。bind group 在 `encode` 之后取：有两张目标时它开头才换，
    // 上屏的必须是这一帧画的那张
    encodeBlit(
      encoder,
      this.context.getCurrentTexture().createView(),
      this.background,
      this.placement.rect,
      this.blitPipeline,
      this.blitBindGroup(scene.targetView!),
    );
    device.queue.submit([encoder.finish()]);
    this.frameCosts.push(performance.now() - started);
    if (this.frameCosts.length > 600) this.frameCosts.splice(0, this.frameCosts.length - 600);
  }
}
