/**
 * 场景渲染器：持有设备、画布上下文、时钟与帧循环，当前场景（`GpuScene`）可无缝替换。
 *
 * - **铺放**：场景先画进场景分辨率的离屏目标，再按 cover（等比盖满、居中裁切）铺到画布。三屏等宽高比差很多的场景
 *   在 WPE 里怎么处理还没对照过，P1 先统一 cover。HDR 场景的离屏目标是 `rgba16float`，泛光 combine 已截到 [0, 1]，
 *   画布（8 位）上直接按编码值输出（见 `compile/bloom.ts`）。
 * - **帧循环**：`requestAnimationFrame`，默认上限 60 fps（`maxFps`）。`paused` 或 `document.hidden` 时停循环、冻结时钟，
 *   恢复后 `g_Time` 从冻结处继续（见 `clock.ts`）。暂停期间画布尺寸变了会补画一帧（同一时刻），避免空白。
 * - **替换**：`load(bundle)` 在同一设备上先建好新场景，再在帧间换掉旧的并释放；时钟不重置。
 * - **失败**：运行期出现未捕获的校验错误时停止渲染、经 `onError` 交出原因；设备丢失（非主动销毁）经 `onLost` 交出。
 */
import type { SceneBinding } from "../compile/bindings";
import type { SceneBundle } from "../compile/bundle";
import type { SceneScalar } from "../compile/model";
import { FrameThrottle, PausableClock } from "./clock";
import { acquireGpu, type Gpu, type GpuAdapterInfo } from "./device";
import { oneLine, SceneRenderError } from "./errors";
import { coverUv, type CoverUv } from "./layout";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import { daytimeOf, TIME_WRAP_SECONDS } from "./uniforms";

/** cover 铺放：全屏三角形，按 `offset + uv * scale` 采样离屏目标，输出不透明。 */
const BLIT_WGSL = /* wgsl */ `
struct Cover { offset: vec2<f32>, scale: vec2<f32> }
@group(0) @binding(0) var<uniform> cover: Cover;
@group(0) @binding(1) var sceneTexture: texture_2d<f32>;
@group(0) @binding(2) var sceneSampler: sampler;
struct VsOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex fn vs(@builtin(vertex_index) index: u32) -> VsOut {
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  var out: VsOut;
  out.position = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = cover.offset + vec2<f32>(p.x, 1.0 - p.y) * cover.scale;
  return out;
}
@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
  return vec4<f32>(textureSample(sceneTexture, sceneSampler, in.uv).rgb, 1.0);
}
`;

/** 帧循环里按显示尺寸核对画布的间隔：transform 变化不触发 ResizeObserver，这样最多晚这么久跟上。 */
const SIZE_CHECK_INTERVAL_MS = 250;

export interface SceneRendererOptions {
  /** 帧率上限；≤ 0 不限（跟随 rAF）。默认 60。 */
  maxFps?: number;
  /** 运行期失败（未捕获的校验错误等），渲染已停止。 */
  onError?: (reasons: string[]) => void;
  /** 设备丢失（非 `destroy()` 引起），渲染已停止；调用方可以重建渲染器。 */
  onLost?: (reasons: string[]) => void;
}

export interface SceneLoadOptions {
  /** dev 强制渲染（D4）：不因 `bundle.unsupported` 拒绝，渲染器自查仍然生效。 */
  ignoreUnsupported?: boolean;
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
  private readonly coverBuffer: GPUBuffer;
  private readonly observer: ResizeObserver | null;
  private scene: GpuScene | null = null;
  /** 当前场景的 CPU 侧状态（就地写的落点，`GpuScene.sync` 每帧取脏项）。 */
  private state: SceneState | null = null;
  private blitBindGroup: GPUBindGroup | null = null;
  private cover: CoverUv = { offset: [0, 0], scale: [1, 1] };
  private coverKey = "";
  /** 光标在画布上的归一化坐标（原点左上、y 向下，PLAN P2a「内置 uniform」）。 */
  private pointer: [number, number] = [0.5, 0.5];
  private pointerLast: [number, number] = [0.5, 0.5];
  /** 上一帧的时钟读数（秒），算 `g_Frametime`。 */
  private lastTime: number | null = null;
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
    const context = canvas.getContext("webgpu");
    if (!context) throw new SceneRenderError(["webgpu:canvas-context"]);
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: this.format, alphaMode: "opaque" });
    const module = device.createShaderModule({ label: "scene cover blit", code: BLIT_WGSL });
    this.blitPipeline = device.createRenderPipeline({
      label: "scene cover blit",
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
    this.coverBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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

  /** 当前 GPU 场景；dev 探针按固定 `g_Time` 读回时用。 */
  get currentScene(): GpuScene | null {
    return this.scene;
  }

  /**
   * 就地应用一批绑定写入；需要重编译时返回 false（调用方整场重编译）。
   * 写之前先问 GPU 场景能不能做（`canApply`：泛光的 `bloomhdriterations` 改变级数时不能），做不了就一条都不写。
   * 暂停时补画一帧（同 resize），画面立即反映、`g_Time` 不动。
   */
  applyBindings(writes: readonly BindingWrite[]): boolean {
    const state = this.state;
    const scene = this.scene;
    if (!state || !scene || this.destroyed || this.lost || this.failed) return false;
    if (writes.some((write) => write.binding.target.kind === "recompile")) return false;
    if (!scene.canApply(state.previewBloom(writes))) return false;
    for (const write of writes) state.write(write.binding, write.value);
    if (!this.shouldRun) this.render();
    return true;
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
    const scene = await GpuScene.build(this.gpu.device, bundle, state, this.gpu.features, this.warnings, options);
    if (this.destroyed || serial !== this.loadSerial) {
      scene.destroy();
      throw new DOMException("已被新的场景取代", "AbortError");
    }
    const old = this.scene;
    this.scene = scene;
    this.state = state;
    this.blitBindGroup = this.gpu.device.createBindGroup({
      layout: this.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.coverBuffer } },
        { binding: 1, resource: scene.targetView! },
        { binding: 2, resource: this.blitSampler },
      ],
    });
    this.coverKey = "";
    old?.destroy();
    this.failed = false;
    this.render();
    await this.gpu.device.queue.onSubmittedWorkDone();
    if (this.failed) throw new SceneRenderError(["webgpu:first-frame"]);
    this.sync();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.sync();
  }

  /** 画布上的指针位置（0…1，左上为原点、y 向下），原样作为 `g_PointerPosition`（WPE 取窗口归一化坐标）。 */
  setPointer(x: number, y: number): void {
    this.pointerLast = this.pointer;
    this.pointer = [x, y];
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
    this.blitBindGroup = null;
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
    // 祖先的 CSS transform 变化（如预览「桌面画布」随弹窗缩放）不触发 ResizeObserver，帧循环里定期按显示尺寸核对
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
   * 画布像素尺寸跟随**显示**尺寸 × DPR；暂停时补画一帧。用 `getBoundingClientRect`（含祖先 CSS transform），
   * 而不是布局尺寸：预览「桌面画布」按桌面尺寸布局、再整体缩小显示，按布局尺寸会在 4K 上渲染只显示约 1/4 面积的画面。
   */
  private resize(): void {
    if (this.destroyed) return;
    const dpr = window.devicePixelRatio || 1;
    const max = this.gpu.device.limits.maxTextureDimension2D;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.min(max, Math.max(1, Math.round(rect.width * dpr)));
    const height = Math.min(max, Math.max(1, Math.round(rect.height * dpr)));
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    if (this.scene && !this.shouldRun) this.render();
  }

  private render(): void {
    const scene = this.scene;
    const state = this.state;
    if (!scene || !state || !this.blitBindGroup || this.destroyed || this.lost || this.failed) return;
    const started = performance.now();
    const device = this.gpu.device;
    const key = `${scene.width}x${scene.height}@${this.canvas.width}x${this.canvas.height}`;
    if (key !== this.coverKey) {
      this.coverKey = key;
      this.cover = coverUv(scene.width, scene.height, this.canvas.width, this.canvas.height);
      device.queue.writeBuffer(this.coverBuffer, 0, new Float32Array([...this.cover.offset, ...this.cover.scale]));
    }
    const seconds = this.clock.seconds();
    const frametime = this.lastTime === null ? 0 : Math.max(0, seconds - this.lastTime);
    this.lastTime = seconds;
    // 就地改过的状态先刷进 uniform 块 / 可见性 / 泛光链，再写每帧内置量（P3a）
    scene.sync(state);
    scene.update({
      time: seconds % TIME_WRAP_SECONDS,
      frametime,
      daytime: daytimeOf(new Date()),
      pointer: this.pointer,
      pointerLast: this.pointerLast,
    });
    this.pointerLast = this.pointer;
    const encoder = device.createCommandEncoder({ label: "scene frame" });
    scene.encode(encoder, state);
    const pass = encoder.beginRenderPass({
      label: "scene cover",
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.blitPipeline);
    pass.setBindGroup(0, this.blitBindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    this.frameCosts.push(performance.now() - started);
    if (this.frameCosts.length > 600) this.frameCosts.splice(0, this.frameCosts.length - 600);
  }
}
