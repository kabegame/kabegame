/**
 * 阴影图集与阴影 pass（P13d，rea-p13-passes 第 2 节，rea-p13-shadows R2–R6）。
 *
 * - 图集 `_rt_shadowAtlas`：`depth32float`，比较采样器 `greater`、线性、clamp（WebGPU 没有 BORDER，越界的边框 0 在着色器里由翻译器的
 *   `kb_shadowCompare` 处理）。尺寸按加载时的打包定（灯是编译期常量，条目数不变；R4.5「够就不动」）。
 * - 每帧（`GpuScene.update`）：`lightFrame` 排序写整块灯光缓冲 → {@link ShadowAtlas.frame} 打包、算各视图的视图投影并把投影与方块变换
 *   写回缓冲（`planShadows`）。
 * - 编码（`GpuScene.encode`，反射 pass 与主 pass 之前）：清深度为 0（反向 Z 的最远，每帧一次），逐条目逐视图设视口、画投射者。WPE 一次
 *   实例化画进最多 6 个视口（`gl_ViewportIndex = gl_InstanceID`），WebGPU 没有视口数组：每个视图单独画一次，`firstInstance` 取视图号，
 *   投射着色器照样按实例号取 `g_ViewportViewProjectionMatrices[i]`（翻译器去掉了 `gl_ViewportIndex` 的赋值）。
 */
import type { SceneBundle } from "../compile/bundle";
import { lightFrame, shadowCount, type LightFrame, type SceneLight } from "../compile/lights";
import { planShadows, type ShadowPlan, type ShadowView } from "./shadowMath";

/** 阴影图集的格式（WPE 是 R32_TYPELESS 的深度）。 */
export const SHADOW_ATLAS_FORMAT: GPUTextureFormat = "depth32float";

/** 一次投射者绘制：每个视图调一次 `draw(view, index)`（视口已设好），由 `GpuScene` 给出。 */
export interface ShadowCasterDraw {
  /** 本条目的全部视图写进这次绘制的 uniform（`g_ViewportViewProjectionMatrices`）；每帧编码前调 */
  prepare(entry: number, views: readonly ShadowView[]): void;
  /** 在已设好视口的 pass 里画第 `view` 个视图（`firstInstance = view`） */
  draw(pass: GPURenderPassEncoder, entry: number, view: number): void;
}

export class ShadowAtlas {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  readonly width: number;
  readonly height: number;
  readonly format = SHADOW_ATLAS_FORMAT;
  /** 最近一帧的计划（视图与布局）；还没 `frame` 过为 null */
  plan: ShadowPlan | null = null;

  private constructor(
    device: GPUDevice,
    width: number,
    height: number,
    private readonly quality: number,
    private readonly orthographic: boolean,
  ) {
    this.width = width;
    this.height = height;
    this.texture = device.createTexture({
      label: "_rt_shadowAtlas",
      size: [width, height],
      format: SHADOW_ATLAS_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.view = this.texture.createView();
    this.sampler = device.createSampler({
      label: "_rt_shadowAtlas comparison",
      compare: "greater",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    });
  }

  /**
   * 有阴影档位与阴影计数时才建（`bundle.lights.quality ≠ 0`、`shadowCount(counts) > 0`，含聚光阴影，P13i）。尺寸按加载时的条目打包（`records` 是
   * 加载时按状态组的灯记录，P13f2）；
   * 没有条目（投射灯都隐藏）时 2×2（WPE 不建，着色器照样声明、读到的是空纹理，这里给一张清成 0 的）。
   */
  static create(
    device: GPUDevice,
    bundle: Pick<SceneBundle, "lights" | "general">,
    records: readonly SceneLight[],
  ): ShadowAtlas | null {
    const lights = bundle.lights;
    if (!lights || !lights.quality || shadowCount(lights.counts) === 0) return null;
    const orthographic = !bundle.general.perspective;
    const frame = lightFrame(records, lights.counts, lights.quality, [0, 0, -1]);
    const plan = planShadows(frame, lights.quality, [0, 0, -1], [0, 0, 0], orthographic, null);
    return new ShadowAtlas(device, plan.width, plan.height, lights.quality, orthographic);
  }

  /** 这一帧：打包、算视图，投影与方块变换写进 `frame.buffer`（`planShadows`）。 */
  frame(frame: LightFrame, forward: readonly number[], eye: readonly number[]): void {
    this.plan = planShadows(
      frame,
      this.quality,
      forward,
      eye,
      this.orthographic,
      { width: this.width, height: this.height },
      this.plan?.layout,
    );
  }

  /** 阴影 pass：清深度为 0，逐条目逐视图画投射者。图集比这一帧要的小时（条目数变了，灯是常量时不会）只画放得下的视口。 */
  encode(encoder: GPUCommandEncoder, casters: readonly ShadowCasterDraw[]): void {
    const pass = encoder.beginRenderPass({
      label: "shadow atlas",
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.view,
        depthClearValue: 0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    const plan = this.plan;
    if (plan && casters.length) {
      plan.views.forEach((views, entry) => {
        for (const caster of casters) caster.prepare(entry, views);
        views.forEach((view, index) => {
          const [x, y, w, h] = view.viewport;
          if (x + w > this.width || y + h > this.height) return;
          pass.setViewport(x, y, w, h, 0, 1);
          for (const caster of casters) caster.draw(pass, entry, index);
        });
      });
    }
    pass.end();
  }

  destroy(): void {
    this.texture.destroy();
  }
}
