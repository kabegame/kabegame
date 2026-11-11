/**
 * 上屏：把场景目标按铺放画进一张颜色附件。渲染器（`renderer.ts`，画布）与 dev 探针（`dev/probe.ts` 的 `renderFrame` 带 `canvas`，
 * 读回用的 `rgba8unorm` 纹理）共用这一份着色器、采样器参数与 pass，探针读回的画布才是产品实际显示的画面。
 *
 * 做法：整个附件先清成留白色，视口设成铺放矩形（`ScenePlacement.rect`），在视口里画全屏三角形，按 `offset + uv * scale` 线性采样
 * 场景目标，输出不透明。
 */
import type { ScenePlacement } from "./layout";

/** 上屏着色器：在视口（铺放矩形）里画全屏三角形，按 `offset + uv * scale` 采样离屏目标，输出不透明。 */
export const BLIT_WGSL = /* wgsl */ `
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

/** 上屏的采样器：线性、边缘钳制（`tile` 以外的样式）。 */
export const BLIT_SAMPLER: GPUSamplerDescriptor = {
  magFilter: "linear",
  minFilter: "linear",
  addressModeU: "clamp-to-edge",
  addressModeV: "clamp-to-edge",
};

/** `tile` 用：纹理坐标超出 0…1 的部分重复。 */
export const TILE_SAMPLER: GPUSamplerDescriptor = {
  magFilter: "linear",
  minFilter: "linear",
  addressModeU: "repeat",
  addressModeV: "repeat",
};

/** 铺放 uniform 的字节数：`offset`、`scale` 各两个 f32。 */
export const PLACEMENT_BYTES = 16;

/** 上屏管线，按颜色附件的格式建（画布是首选画布格式，探针读回是 `rgba8unorm`）。 */
export function createBlitPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
  const module = device.createShaderModule({ label: "scene blit", code: BLIT_WGSL });
  return device.createRenderPipeline({
    label: "scene blit",
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
}

/** 铺放 uniform 的内容（`writeBuffer` 到 `PLACEMENT_BYTES` 大小的 uniform 缓冲）。 */
export function placementUniform(placement: ScenePlacement): Float32Array<ArrayBuffer> {
  return new Float32Array([...placement.offset, ...placement.scale]);
}

/** 上屏的 bind group：铺放 uniform、场景目标的视图、采样器。 */
export function createBlitBindGroup(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  placementBuffer: GPUBuffer,
  view: GPUTextureView,
  sampler: GPUSampler,
): GPUBindGroup {
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: placementBuffer } },
      { binding: 1, resource: view },
      { binding: 2, resource: sampler },
    ],
  });
}

/**
 * 编码一次上屏 pass：整个附件清成留白色（0…1 的 RGB），视口设成铺放矩形，画 3 个顶点。场景目标要在调用之前编码好
 * （有两张目标时取 `encode` 之后的那张，见 `GpuScene.targetView`）。
 */
export function encodeBlit(
  encoder: GPUCommandEncoder,
  target: GPUTextureView,
  background: readonly [number, number, number],
  rect: ScenePlacement["rect"],
  pipeline: GPURenderPipeline,
  bindGroup: GPUBindGroup,
): void {
  const pass = encoder.beginRenderPass({
    label: "scene blit",
    colorAttachments: [
      {
        view: target,
        // 留白：整屏清成这个颜色，再把场景画进铺放矩形
        clearValue: { r: background[0], g: background[1], b: background[2], a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  pass.setViewport(...rect, 0, 1);
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
}
