/**
 * 用户纹理的 PNG gamma 校正（P11b 步骤 2，p11-REPORT M9）：在 GPU 上传时逐字节查表，不在 CPU 读回像素。
 * 2D 画布的 `getImageData` 内部是预乘 alpha，半透明像素有舍入损失；WPE 是直通 alpha，要逐像素对上，所以走 GPU：
 * 位图先 `copyExternalImageToTexture`（`premultipliedAlpha: false`）进一张同尺寸的临时 `rgba8unorm`，再用全屏三角形把它画进最终纹理，
 * 片元 `textureLoad` 取像素，RGB 各自 `lut[u32(round(c · 255))] / 255`，alpha 原样。目标 `rgba8unorm`、不混合：
 * unorm8 → f32 → ×255 取整回到原字节，输出 l/255 写回就是 l，每个字节都精确。
 * 表（256 项）放 uniform，`array<vec4<u32>, 64>`。
 */

export const GAMMA_WGSL = /* wgsl */ `
struct Lut { v: array<vec4<u32>, 64> };
@group(0) @binding(0) var<uniform> lut: Lut;
@group(0) @binding(1) var src: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}

fn map(c: f32) -> f32 {
  let i = u32(round(c * 255.0));
  return f32(lut.v[i >> 2u][i & 3u]) / 255.0;
}

@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let t = textureLoad(src, vec2<i32>(pos.xy), 0);
  return vec4<f32>(map(t.r), map(t.g), map(t.b), t.a);
}
`;

/** 校正管线：按需建一次，随场景销毁（模块与管线由设备持有，这里不单独释放）。 */
export interface GammaPass {
  pipeline: GPURenderPipeline;
}

export function createGammaPass(device: GPUDevice): GammaPass {
  const module = device.createShaderModule({ label: "user texture gamma", code: GAMMA_WGSL });
  const pipeline = device.createRenderPipeline({
    label: "user texture gamma",
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-list" },
  });
  return { pipeline };
}

/** 表的 uniform 数据：256 个 u32（每项一个字节值）。 */
export function gammaUniform(table: Uint8Array): Uint32Array<ArrayBuffer> {
  const data = new Uint32Array(new ArrayBuffer(1024));
  for (let i = 0; i < 256; i++) data[i] = table[i] ?? i;
  return data;
}

/** 把 `source`（临时纹理）按表查过画进 `target`；返回用完的 uniform 缓冲，调用方在提交后释放。 */
export function encodeGamma(
  device: GPUDevice,
  gamma: GammaPass,
  table: Uint8Array,
  source: GPUTexture,
  target: GPUTexture,
): GPUBuffer {
  const data = gammaUniform(table);
  const buffer = device.createBuffer({
    label: "user texture gamma lut",
    size: data.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  const bindGroup = device.createBindGroup({
    label: "user texture gamma",
    layout: gamma.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer } },
      { binding: 1, resource: source.createView() },
    ],
  });
  const encoder = device.createCommandEncoder({ label: "user texture gamma" });
  const pass = encoder.beginRenderPass({
    label: "user texture gamma",
    colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
  });
  pass.setPipeline(gamma.pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  return buffer;
}
