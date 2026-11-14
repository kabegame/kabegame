/**
 * sprite 对象的渲染（P13c，`.claude/plans/wpe-import/3-scene/phase13/phase-13c-sprite.md`；读码 rea-p13-lights 4.2，实测 p13-REPORT「P13c
 * 的实测」）。
 *
 * WPE 的绘制（`FUN_140256780`）：取上一帧遮挡查询的样本数 n，`k = min(512 · ((n/2) >> s) / Hs², 1)`（S1：`s = 0`，`Hs` 是后备缓冲高）；视图
 * 去掉平移；光斑的 `g_ViewUp` / `g_ViewRight` 乘 `2k`、`g_Alpha = k²`；遮挡方块的两个轴乘 0.2，只写 alpha，测深度（GREATER）。S2 实测
 * WPE 总能拿到上一帧的结果（不闪）。
 *
 * n 我们自己数，k 也在 GPU 上算，不读回 CPU：
 * - **计数**：Dawn 的 D3D12 后端只有布尔遮挡查询（`D3D12_QUERY_TYPE_BINARY_OCCLUSION`），给不出个数。画到遮挡方块之前插一个计数 pass：
 *   同一个顶点着色器、同一组顶点与 uniform 光栅化（覆盖的像素和遮挡方块逐个相同），片元着色器读场景深度、按 GREATER 自己比较，通过的
 *   `atomicAdd` 进计数缓冲。
 * - **k**：每帧画光斑之前跑一个计算 pass，从计数缓冲读样本数（这时里面还是上一帧数的），按 WPE 的公式算 k，把 `g_ViewUp` / `g_ViewRight`
 *   / `g_Alpha` 直接写进光斑的 uniform 缓冲（缓冲带 STORAGE 用途，CPU 上传的块在本帧命令执行之前落地，计算 pass 的结果盖在它上面）。所以
 *   用的正好是上一帧的结果，和 WPE 一样，产品与 dev 探针的回放都确定、没有读回延迟。首帧计数缓冲是 0，k = 0（同 WPE）。
 */
import type { GpuProgram } from "./programs";
import { multiply, type Mat4 } from "./math";

/** 遮挡方块的两个轴长（WPE 常量 `0x14049267c`）。 */
export const SPRITE_OCCLUSION_AXIS = 0.2;

/**
 * 光斑的尺寸系数 k（WPE 的公式，float32 逐步）：`samples` 是遮挡方块通过的样本数，`height` 是场景目标高（WPE 的后备缓冲高）。渲染时在 GPU
 * 上算（`SCALE_WGSL`，同一个式子）；这里是参照，单测与文档用。
 */
export function spriteScale(samples: number, height: number): number {
  const h = Math.trunc(samples / 2);
  return Math.min(Math.fround(Math.fround(Math.fround(h) / Math.fround(height * height)) * 512), 1);
}

/** sprite 的视图投影 `P · V'`：V' 是场景视图去掉平移（光斑只随相机转、不随相机移，S5）；模型矩阵是单位阵（对象变换不参与）。 */
export function spriteViewProjection(camera: { projection: Mat4; view: Mat4 }): Mat4 {
  const view = new Float32Array(camera.view);
  view[12] = 0;
  view[13] = 0;
  view[14] = 0;
  return multiply(camera.projection, view);
}

/**
 * sprite 两次绘制在 CPU 上的覆盖：遮挡方块两个轴乘 0.2；光斑按 k = 0 写（两个轴为 0、`g_Alpha` 为 0），真正的值由计算 pass 每帧盖上
 * （`SpriteCounter.encodeScale`）。遮挡方块不写 `g_Alpha`（WPE 不恢复光斑写的值，`occlusiontest` 也不读）。
 */
export function spriteOverrides(
  values: Record<string, number[]>,
  occlusion: boolean,
  vectors: { up: readonly number[]; right: readonly number[] },
): Record<string, number[]> {
  const axis = occlusion ? SPRITE_OCCLUSION_AXIS : 0;
  values.g_ViewUp = vectors.up.map((x) => x * axis);
  values.g_ViewRight = vectors.right.map((x) => x * axis);
  if (!occlusion) values.g_Alpha = [0];
  return values;
}

/** 计数的片元着色器：读场景深度（GREATER，同遮挡方块的深度测试），通过的样本计数。颜色目标写掩码 0，输出不落地。 */
const COUNT_WGSL = /* wgsl */ `
@group(1) @binding(0) var kb_depth: texture_depth_2d;
@group(1) @binding(1) var<storage, read_write> kb_count: atomic<u32>;

@fragment
fn kb_sprite_count(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let depth = textureLoad(kb_depth, vec2<i32>(position.xy), 0);
  if (position.z > depth) {
    atomicAdd(&kb_count, 1u);
  }
  return vec4<f32>(0.0);
}
`;

/**
 * 算 k、写光斑 uniform 的计算着色器。`offsets` 是三个成员在块里的 32 位字下标（`0xffffffff` 表示程序没有这个成员）；`up` / `right` 是本帧的
 * 视图向量（未缩放）。k 的式子同 `spriteScale`：`(n / 2)` 整除，`h / Hs² · 512` 按 f32，钳到 1。
 */
const SCALE_WGSL = /* wgsl */ `
struct Params {
  up: vec3<f32>,
  heightSquared: f32,
  right: vec3<f32>,
  upOffset: u32,
  rightOffset: u32,
  alphaOffset: u32,
}
@group(0) @binding(0) var<storage, read> kb_count: u32;
@group(0) @binding(1) var<uniform> kb_params: Params;
@group(0) @binding(2) var<storage, read_write> kb_block: array<f32>;

fn kb_write3(offset: u32, value: vec3<f32>) {
  if (offset == 0xffffffffu) { return; }
  kb_block[offset] = value.x;
  kb_block[offset + 1u] = value.y;
  kb_block[offset + 2u] = value.z;
}

@compute @workgroup_size(1)
fn kb_sprite_scale() {
  let h = f32(kb_count / 2u);
  let k = min(h / kb_params.heightSquared * 512.0, 1.0);
  let axis = 2.0 * k;
  kb_write3(kb_params.upOffset, kb_params.up * axis);
  kb_write3(kb_params.rightOffset, kb_params.right * axis);
  if (kb_params.alphaOffset != 0xffffffffu) {
    kb_block[kb_params.alphaOffset] = k * k;
  }
}
`;

/** 计数 pass 的颜色目标格式（只为满足「至少一个附件」，写掩码 0）。 */
export const SPRITE_COUNT_TARGET_FORMAT: GPUTextureFormat = "r8unorm";

/** 光斑 draw 的 uniform 缓冲与三个成员的字节偏移（没有的为 undefined）。 */
export interface SpriteBodyBlock {
  buffer: GPUBuffer;
  up: number | undefined;
  right: number | undefined;
  alpha: number | undefined;
}

/** 遮挡方块这次绘制要的东西（`GpuScene` 的 draw）。 */
export interface SpriteCountDraw {
  bindGroup: GPUBindGroup;
  vertexBuffer: GPUBuffer;
  placeholder: GPUBuffer | null;
  indexBuffer: GPUBuffer;
  indexFormat: GPUIndexFormat;
  count: number;
}

/**
 * 参数块（`SCALE_WGSL` 的 `Params`，WGSL 对齐）：字 0–2 `up`、3 `heightSquared`、4–6 `right`、7 `upOffset`、8 `rightOffset`、9
 * `alphaOffset`；结构按 16 对齐，共 48 字节。
 */
const PARAMS_SIZE = 48;
const NO_OFFSET = 0xffffffff;

/** 一个 sprite 的遮挡计数与 k（每个 sprite 图层一份，`GpuScene` 持有）。 */
export class SpriteCounter {
  private readonly counter: GPUBuffer;
  private readonly params: GPUBuffer;
  private readonly countPipeline: GPURenderPipeline;
  private readonly countLayout: GPUBindGroupLayout;
  private readonly scalePipeline: GPUComputePipeline;
  private countGroup: { depth: GPUTextureView; group: GPUBindGroup } | null = null;
  private scaleGroup: { block: GPUBuffer; group: GPUBindGroup } | null = null;

  constructor(
    private readonly device: GPUDevice,
    /** 遮挡方块的程序、bind group 布局（组 0）与顶点布局（`meshVertexLayout`）：计数 pass 用同一个顶点着色器。 */
    occlusion: { program: GpuProgram; layout: GPUBindGroupLayout; vertexBuffers: GPUVertexBufferLayout[] },
    /** 建出来的缓冲交给场景统一销毁（`GpuScene.own`）。 */
    own: (buffer: GPUBuffer) => GPUBuffer,
    label: string,
  ) {
    // 首帧是 0（创建时清零），k = 0，同 WPE
    this.counter = own(
      device.createBuffer({
        label: `${label} count`,
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
    );
    this.params = own(
      device.createBuffer({
        label: `${label} scale params`,
        size: PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
    );
    this.countLayout = device.createBindGroupLayout({
      label: `${label} count`,
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "storage" } },
      ],
    });
    this.countPipeline = device.createRenderPipeline({
      label: `${label} count`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [occlusion.layout, this.countLayout] }),
      vertex: {
        module: occlusion.program.vertex,
        entryPoint: occlusion.program.result.vertex?.entryPoint ?? "main",
        buffers: occlusion.vertexBuffers,
      },
      fragment: {
        module: device.createShaderModule({ label: `${label} count`, code: COUNT_WGSL }),
        entryPoint: "kb_sprite_count",
        targets: [{ format: SPRITE_COUNT_TARGET_FORMAT, writeMask: 0 }],
      },
      // 同遮挡方块：occlusiontest 是 nocull
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
    this.scalePipeline = device.createComputePipeline({
      label: `${label} scale`,
      layout: "auto",
      compute: {
        module: device.createShaderModule({ label: `${label} scale`, code: SCALE_WGSL }),
        entryPoint: "kb_sprite_scale",
      },
    });
  }

  /**
   * 计算 pass：按计数缓冲里（上一帧数的）样本数算 k，写进光斑的 uniform 缓冲。画光斑之前调。`heightSquared` 是场景目标高的平方（整数乘，
   * 同 WPE），`vectors` 是本帧的视图向量。
   */
  encodeScale(
    encoder: GPUCommandEncoder,
    body: SpriteBodyBlock,
    heightSquared: number,
    vectors: { up: readonly number[]; right: readonly number[] },
  ): void {
    const data = new ArrayBuffer(PARAMS_SIZE);
    const f32 = new Float32Array(data);
    const u32 = new Uint32Array(data);
    f32.set(vectors.up.slice(0, 3), 0);
    f32[3] = heightSquared;
    f32.set(vectors.right.slice(0, 3), 4);
    const word = (offset: number | undefined) => (offset === undefined ? NO_OFFSET : offset >> 2);
    u32[7] = word(body.up);
    u32[8] = word(body.right);
    u32[9] = word(body.alpha);
    this.device.queue.writeBuffer(this.params, 0, data);
    if (this.scaleGroup?.block !== body.buffer)
      this.scaleGroup = {
        block: body.buffer,
        group: this.device.createBindGroup({
          label: "sprite scale",
          layout: this.scalePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.counter } },
            { binding: 1, resource: { buffer: this.params } },
            { binding: 2, resource: { buffer: body.buffer } },
          ],
        }),
      };
    const pass = encoder.beginComputePass({ label: "sprite scale" });
    pass.setPipeline(this.scalePipeline);
    pass.setBindGroup(0, this.scaleGroup.group);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  /**
   * 计数 pass：清零计数、按遮挡方块的几何光栅化、通过的样本计数。`depth` 是场景深度纹理的视图（这时不能挂在 pass 上），`target` 是和场景目标
   * 同尺寸的 `r8unorm` 纹理（只为满足附件要求）。
   */
  encodeCount(encoder: GPUCommandEncoder, depth: GPUTextureView, target: GPUTextureView, draw: SpriteCountDraw): void {
    if (this.countGroup?.depth !== depth)
      this.countGroup = {
        depth,
        group: this.device.createBindGroup({
          label: "sprite count",
          layout: this.countLayout,
          entries: [
            { binding: 0, resource: depth },
            { binding: 1, resource: { buffer: this.counter } },
          ],
        }),
      };
    encoder.clearBuffer(this.counter);
    const pass = encoder.beginRenderPass({
      label: "sprite occlusion count",
      colorAttachments: [{ view: target, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "discard" }],
    });
    pass.setPipeline(this.countPipeline);
    pass.setBindGroup(0, draw.bindGroup);
    pass.setBindGroup(1, this.countGroup.group);
    pass.setVertexBuffer(0, draw.vertexBuffer);
    if (draw.placeholder) pass.setVertexBuffer(1, draw.placeholder);
    pass.setIndexBuffer(draw.indexBuffer, draw.indexFormat);
    pass.drawIndexed(draw.count);
    pass.end();
  }
}
