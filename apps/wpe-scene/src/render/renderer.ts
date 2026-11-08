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
 * - **替换**：`load(bundle)` 在同一设备上先建好新场景，再在帧间换掉旧的并释放；时钟不重置。
 * - **失败**：运行期出现未捕获的校验错误或一帧的 CPU 部分抛错时停止渲染、经 `onError` 交出原因；设备丢失（非主动销毁）经 `onLost` 交出。
 */
import type { SceneBinding } from "../compile/bindings";
import type { SceneBundle } from "../compile/bundle";
import type { SceneScalar } from "../compile/model";
import { particlePasses } from "../particles/system";
import { TIME_WRAP_SECONDS } from "../sceneTime";
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
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import { daytimeOf } from "./uniforms";

/** 上屏：在视口（铺放矩形）里画全屏三角形，按 `offset + uv * scale` 采样离屏目标，输出不透明。 */
const BLIT_WGSL = /* wgsl */ `
struct Placement { offset: vec2<f32>, scale: vec2<f32> }
@group(0) @binding(0) var<uniform> placement: Placement;
@group(0) @binding(1) var sceneTexture: texture_2d<f32>;
@group(0) @binding(2) var sceneSampler: sampler;
struct VsOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex fn vs(@builtin(vertex_index) index: u32) -> VsOut {
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  var out: VsOut;
  out.position = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = placement.offset + vec2<f32>(p.x, 1.0 - p.y) * placement.scale;
  return out;
}
@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
  return vec4<f32>(textureSample(sceneTexture, sceneSampler, in.uv).rgb, 1.0);
}
`;

/**
 * 帧循环里核对画布尺寸的间隔：DPR 变化（换显示器、改系统缩放）不触发 ResizeObserver，这样最多晚这么久跟上。
 * 父页面的 CSS transform 跨不进 iframe，这里量不到，由父页面量好经 `setDisplayScale` 交来。
 */
const SIZE_CHECK_INTERVAL_MS = 250;

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
  /** 每个实际渲染帧在状态同步前执行；暂停时不执行。 */
  beforeFrame?: (dt: number) => void;
}

export interface SceneLoadOptions {
  /** dev 强制渲染（D4）：不因 `bundle.unsupported` 拒绝，渲染器自查仍然生效。 */
  ignoreUnsupported?: boolean;
  /** 新状态建好后、首帧绘制前同步执行。 */
  beforeFirstFrame?: (state: SceneState) => void;
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
   * 只在宿主收到事件时更新（预览是光标在 iframe 上时，桌面是鼠标转发时），之外保持最后的值；WPE 用全局光标、窗口外也跟踪，
   * 这点差别不处理。
   */
  private canvasPointer: [number, number] | null = null;
  /** `g_Time` / `g_Frametime`：钳过的帧时间与它的累加（T2）。换场景不重置。 */
  private readonly frameClock = new FrameClock();
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
    const module = device.createShaderModule({ label: "scene blit", code: BLIT_WGSL });
    this.blitPipeline = device.createRenderPipeline({
      label: "scene blit",
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list" },
    });
    this.blitSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.tileSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
    this.placementBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
    // 加载时的控制点更新和预热用加载时刻的 cursor（WPE 加载时也读当时的指针，rea-p4c-sim.md 1.3、1.7）：按新场景的尺寸现算
    // 一次铺放，尺寸取法同 `GpuScene.width/height`，和之后 `syncPlacement` 算的一致
    const [sceneWidth, sceneHeight] = sceneTargetSize(
      bundle.general.width,
      bundle.general.height,
      this.gpu.device.limits.maxTextureDimension2D,
    );
    const placement = scenePlacement(
      this.style,
      sceneWidth,
      sceneHeight,
      this.canvas.width,
      this.canvas.height,
      this.pixelRatio,
    );
    const scene = await GpuScene.build(this.gpu.device, bundle, state, this.gpu.features, this.warnings, {
      ignoreUnsupported: options.ignoreUnsupported,
      particles: { passes: particlePasses(this.options.maxFps ?? 60), cursor: this.cursorOf(placement) },
    });
    if (this.destroyed || serial !== this.loadSerial) {
      scene.destroy();
      throw new DOMException("已被新的场景取代", "AbortError");
    }
    const old = this.scene;
    this.scene = scene;
    this.state = state;
    this.blitBindGroups.clear();
    this.placementKey = "";
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
    this.pointer = scenePointer(this.style, this.placement, this.canvas.width, this.canvas.height, x, y);
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

  private blitBindGroup(view: GPUTextureView): GPUBindGroup {
    let group = this.blitBindGroups.get(view);
    if (!group) {
      group = this.gpu.device.createBindGroup({
        layout: this.blitPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.placementBuffer } },
          { binding: 1, resource: view },
          { binding: 2, resource: this.style === "tile" ? this.tileSampler : this.blitSampler },
        ],
      });
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
    const key = `${this.style}:${scene.width}x${scene.height}@${this.canvas.width}x${this.canvas.height}@${ratio}`;
    if (key === this.placementKey) return;
    this.placementKey = key;
    this.placement = scenePlacement(
      this.style,
      scene.width,
      scene.height,
      this.canvas.width,
      this.canvas.height,
      ratio,
    );
    this.gpu.device.queue.writeBuffer(
      this.placementBuffer,
      0,
      new Float32Array([...this.placement.offset, ...this.placement.scale]),
    );
  }

  /** 光标下的场景纹理坐标（`sceneCursor`，P4c 步骤 2）：按当前样式与给定铺放从 `canvasPointer` 现算；没收到过指针时取场景中心。 */
  private cursorOf(placement: ScenePlacement): [number, number] {
    const pointer = this.canvasPointer;
    if (!pointer) return [0.5, 0.5];
    return sceneCursor(this.style, placement, this.canvas.width, this.canvas.height, pointer[0], pointer[1]);
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
    const { time, frametime } = this.frameClock;
    if (live) this.options.beforeFrame?.(frametime);
    const encoder = device.createCommandEncoder({ label: "scene frame" });
    try {
      // 就地改过的状态先刷进 uniform 块 / 可见性 / 泛光链，再写每帧内置量与粒子（P3a、P4a）
      scene.sync(state);
      scene.update(
        {
          time: time % TIME_WRAP_SECONDS,
          frametime,
          daytime: daytimeOf(new Date()),
          pointer: this.pointer,
          pointerLast: this.pointerLast,
          // 每帧现算（`syncPlacement` 之后）：改样式、改尺寸不经 `setPointer` 也跟上
          cursor: this.cursorOf(this.placement),
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
    const pass = encoder.beginRenderPass({
      label: "scene blit",
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          // 留白：整屏清成这个颜色，再把场景画进铺放矩形
          clearValue: { r: this.background[0], g: this.background[1], b: this.background[2], a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setViewport(...this.placement.rect, 0, 1);
    pass.setPipeline(this.blitPipeline);
    // `encode` 之后取：有两张目标时它开头才换，上屏的必须是这一帧画的那张
    pass.setBindGroup(0, this.blitBindGroup(scene.targetView!));
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    this.frameCosts.push(performance.now() - started);
    if (this.frameCosts.length > 600) this.frameCosts.splice(0, this.frameCosts.length - 600);
  }
}
