/**
 * 逐 draw 记录器（`trace.ts`）：用带品牌检查的假 GPU 对象验——真 WebGPU 只认它自己建的对象（参数与 `this`），这里用 `REAL` 登记，
 * 代理或别的对象交进来就抛 TypeError。假设备的队列在 `submit` 时按顺序执行命令缓冲里的拷贝，读回能拿到纹理内容。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  convertReadback,
  createDrawTracer,
  decodeUniforms,
  readVertexAttribute,
  traceUniforms,
  type DrawTracer,
  type TraceOptions,
} from "./trace";
import { UniformBlock, type UniformEntry } from "./uniforms";

/** WebGPU 规范里的位值。 */
const B = { MAP_READ: 0x1, MAP_WRITE: 0x2, COPY_SRC: 0x4, COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40 };
const T = { COPY_SRC: 0x1, COPY_DST: 0x2, TEXTURE_BINDING: 0x4, RENDER_ATTACHMENT: 0x10 };

const REAL = new WeakSet<object>();
const real = <O extends object>(object: O): O => {
  REAL.add(object);
  return object;
};
function brand(value: unknown, what: string): void {
  if (!value || typeof value !== "object" || !REAL.has(value)) throw new TypeError(`${what} 不是 WebGPU 自己的对象`);
}

class FakeBuffer {
  memory: Uint8Array;
  private ranges: { offset: number; range: ArrayBuffer }[] = [];
  destroyed = false;
  constructor(readonly descriptor: GPUBufferDescriptor) {
    real(this);
    this.memory = new Uint8Array(descriptor.size);
  }
  get size() {
    return this.descriptor.size;
  }
  get usage() {
    return this.descriptor.usage;
  }
  get label() {
    return this.descriptor.label ?? "";
  }
  getMappedRange(offset = 0, size?: number): ArrayBuffer {
    brand(this, "getMappedRange 的 this");
    const range = this.memory.slice(offset, offset + (size ?? this.memory.length - offset)).buffer;
    this.ranges.push({ offset, range });
    return range;
  }
  unmap(): void {
    brand(this, "unmap 的 this");
    // 真 WebGPU：unmap 时把映射区写回，并分离给出去的 ArrayBuffer
    for (const { offset, range } of this.ranges) {
      this.memory.set(new Uint8Array(range), offset);
      structuredClone(range, { transfer: [range] });
    }
    this.ranges = [];
  }
  async mapAsync(): Promise<void> {
    brand(this, "mapAsync 的 this");
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeTexture {
  /** mip 0 的内容（紧排），读回时拷出。 */
  content: Uint8Array | null = null;
  constructor(readonly descriptor: GPUTextureDescriptor) {
    real(this);
  }
  get label() {
    return this.descriptor.label ?? "";
  }
  get format() {
    return this.descriptor.format;
  }
  get usage() {
    return this.descriptor.usage;
  }
  get width() {
    return (this.descriptor.size as number[])[0];
  }
  get height() {
    return (this.descriptor.size as number[])[1] ?? 1;
  }
  createView(descriptor?: GPUTextureViewDescriptor) {
    brand(this, "createView 的 this");
    return real({ texture: this, descriptor, label: descriptor?.label ?? "" });
  }
  destroy(): void {}
}

const TEXEL: Record<string, number> = { rgba8unorm: 4, bgra8unorm: 4, rgba16float: 8, r8unorm: 1 };

class FakeCommandBuffer {
  constructor(
    readonly commands: { kind: string; args: unknown[] }[],
    readonly invalid: string | null,
  ) {
    real(this);
  }
}

class FakePass {
  calls: { name: string; args: unknown[] }[] = [];
  constructor(readonly descriptor: GPURenderPassDescriptor) {
    real(this);
  }
  private log(name: string, args: unknown[], objects: unknown[] = []) {
    brand(this, `${name} 的 this`);
    objects.forEach((object, i) => object !== null && object !== undefined && brand(object, `${name} 参数 ${i}`));
    this.calls.push({ name, args });
  }
  setPipeline(...args: unknown[]) {
    this.log("setPipeline", args, [args[0]]);
  }
  setBindGroup(...args: unknown[]) {
    this.log("setBindGroup", args, [args[1]]);
  }
  setVertexBuffer(...args: unknown[]) {
    this.log("setVertexBuffer", args, [args[1]]);
  }
  setIndexBuffer(...args: unknown[]) {
    this.log("setIndexBuffer", args, [args[0]]);
  }
  setViewport(...args: unknown[]) {
    this.log("setViewport", args);
  }
  setScissorRect(...args: unknown[]) {
    this.log("setScissorRect", args);
  }
  draw(...args: unknown[]) {
    this.log("draw", args);
  }
  drawIndexed(...args: unknown[]) {
    this.log("drawIndexed", args);
  }
  insertDebugMarker(...args: unknown[]) {
    this.log("insertDebugMarker", args);
  }
  end() {
    this.log("end", []);
  }
}

class FakeEncoder {
  commands: { kind: string; args: unknown[] }[] = [];
  invalid: string | null = null;
  passes: FakePass[] = [];
  constructor(readonly descriptor?: GPUCommandEncoderDescriptor) {
    real(this);
  }
  beginRenderPass(descriptor: GPURenderPassDescriptor) {
    brand(this, "beginRenderPass 的 this");
    for (const attachment of descriptor.colorAttachments) if (attachment) brand(attachment.view, "颜色附件");
    const pass = new FakePass(descriptor);
    this.passes.push(pass);
    return pass;
  }
  copyTextureToBuffer(source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyBufferInfo, size: GPUExtent3D) {
    brand(this, "copyTextureToBuffer 的 this");
    brand(source.texture, "拷贝源纹理");
    brand(destination.buffer, "拷贝目标缓冲");
    // 真 WebGPU：源纹理没有 COPY_SRC 是校验错误，整个命令缓冲无效
    if (!(source.texture.usage & T.COPY_SRC)) this.invalid = "源纹理没有 COPY_SRC";
    this.commands.push({ kind: "copyTextureToBuffer", args: [source, destination, size] });
  }
  copyBufferToBuffer(...args: unknown[]) {
    brand(this, "copyBufferToBuffer 的 this");
    brand(args[0], "源缓冲");
    brand(args[2], "目标缓冲");
    this.commands.push({ kind: "copyBufferToBuffer", args });
  }
  pushDebugGroup(label: string) {
    brand(this, "pushDebugGroup 的 this");
    return `group:${label}`;
  }
  finish() {
    brand(this, "finish 的 this");
    return new FakeCommandBuffer(this.commands, this.invalid);
  }
}

class FakeQueue {
  writes: unknown[][] = [];
  submitted: FakeCommandBuffer[] = [];
  errors: string[] = [];
  constructor() {
    real(this);
  }
  writeBuffer(...args: unknown[]) {
    brand(this, "writeBuffer 的 this");
    brand(args[0], "writeBuffer 的缓冲");
    this.writes.push(args);
    const buffer = args[0] as FakeBuffer;
    const data = args[2] as ArrayBufferView | ArrayBuffer;
    const element = ArrayBuffer.isView(data) ? ((data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1) : 1;
    const base = ArrayBuffer.isView(data) ? data.byteOffset : 0;
    const bytes = ArrayBuffer.isView(data) ? data.buffer : data;
    const start = base + ((args[3] as number | undefined) ?? 0) * element;
    const length =
      args[4] === undefined
        ? (ArrayBuffer.isView(data) ? data.byteLength + base : bytes.byteLength) - start
        : (args[4] as number) * element;
    buffer.memory.set(new Uint8Array(bytes, start, length), args[1] as number);
  }
  writeTexture(...args: unknown[]) {
    brand(this, "writeTexture 的 this");
    brand((args[0] as GPUTexelCopyTextureInfo).texture, "writeTexture 的纹理");
  }
  submit(commandBuffers: FakeCommandBuffer[]) {
    brand(this, "submit 的 this");
    for (const commandBuffer of commandBuffers) {
      brand(commandBuffer, "命令缓冲");
      this.submitted.push(commandBuffer);
      if (commandBuffer.invalid) {
        this.errors.push(commandBuffer.invalid);
        continue;
      }
      for (const command of commandBuffer.commands) {
        if (command.kind === "copyBufferToBuffer") {
          const [src, srcOffset, dst, dstOffset, size] = command.args as [
            FakeBuffer,
            number,
            FakeBuffer,
            number,
            number,
          ];
          dst.memory.set(src.memory.subarray(srcOffset, srcOffset + size), dstOffset);
        } else {
          const [source, destination, size] = command.args as [
            { texture: FakeTexture; mipLevel?: number },
            { buffer: FakeBuffer; bytesPerRow: number },
            { width: number; height: number },
          ];
          const texel = TEXEL[source.texture.format];
          const content =
            source.texture.content ?? new Uint8Array(source.texture.width * source.texture.height * texel);
          for (let y = 0; y < size.height; y++)
            destination.buffer.memory.set(
              content.subarray(y * source.texture.width * texel, y * source.texture.width * texel + size.width * texel),
              y * destination.bytesPerRow,
            );
        }
      }
    }
  }
  async onSubmittedWorkDone() {
    brand(this, "onSubmittedWorkDone 的 this");
  }
}

class FakeDevice {
  readonly queue = new FakeQueue();
  buffers: FakeBuffer[] = [];
  textures: FakeTexture[] = [];
  encoders: FakeEncoder[] = [];
  descriptors: Record<string, unknown[]> = {};
  scopes: string[] = [];
  private name = "dev";
  constructor() {
    real(this);
  }
  private seen(kind: string, descriptor: unknown) {
    brand(this, `${kind} 的 this`);
    (this.descriptors[kind] ??= []).push(descriptor);
  }
  get limits() {
    brand(this, "limits 的 this");
    return { maxTextureDimension2D: 8192 };
  }
  get label() {
    brand(this, "label 的 this");
    return this.name;
  }
  set label(value: string) {
    brand(this, "label 的 this");
    this.name = value;
  }
  createBuffer(descriptor: GPUBufferDescriptor) {
    this.seen("createBuffer", descriptor);
    const buffer = new FakeBuffer(descriptor);
    this.buffers.push(buffer);
    return buffer;
  }
  createTexture(descriptor: GPUTextureDescriptor) {
    this.seen("createTexture", descriptor);
    const texture = new FakeTexture(descriptor);
    this.textures.push(texture);
    return texture;
  }
  createSampler(descriptor?: GPUSamplerDescriptor) {
    this.seen("createSampler", descriptor);
    return real({ label: descriptor?.label ?? "" });
  }
  createShaderModule(descriptor: GPUShaderModuleDescriptor) {
    this.seen("createShaderModule", descriptor);
    return real({ label: descriptor.label ?? "" });
  }
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor) {
    this.seen("createBindGroupLayout", descriptor);
    return real({ label: descriptor.label ?? "" });
  }
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor) {
    this.seen("createRenderPipeline", descriptor);
    brand(descriptor.vertex.module, "顶点着色器模块");
    if (descriptor.fragment) brand(descriptor.fragment.module, "片元着色器模块");
    return real({ label: descriptor.label ?? "", getBindGroupLayout: () => real({}) });
  }
  createRenderPipelineAsync(descriptor: GPURenderPipelineDescriptor) {
    return Promise.resolve(this.createRenderPipeline(descriptor));
  }
  createBindGroup(descriptor: GPUBindGroupDescriptor) {
    this.seen("createBindGroup", descriptor);
    brand(descriptor.layout, "bind group 的 layout");
    for (const entry of descriptor.entries) {
      const resource = entry.resource as { buffer?: unknown };
      brand(resource.buffer ?? resource, `binding ${entry.binding}`);
    }
    return real({ label: descriptor.label ?? "" });
  }
  createCommandEncoder(descriptor?: GPUCommandEncoderDescriptor) {
    this.seen("createCommandEncoder", descriptor);
    const encoder = new FakeEncoder(descriptor);
    this.encoders.push(encoder);
    return encoder;
  }
  pushErrorScope(filter: string) {
    brand(this, "pushErrorScope 的 this");
    this.scopes.push(filter);
  }
  /** 记录器不认识的方法：原样转发。 */
  frobnicate(a: number, b: number) {
    brand(this, "frobnicate 的 this");
    return a * 10 + b;
  }
}

function setup(options?: TraceOptions): { fake: FakeDevice; tracer: DrawTracer; device: GPUDevice } {
  const fake = new FakeDevice();
  const tracer = createDrawTracer(fake as unknown as GPUDevice, options);
  return { fake, tracer, device: tracer.device };
}

const shader = (device: GPUDevice, label: string) => device.createShaderModule({ label, code: "" });

/** 一个只画颜色附件的简单管线（顶点缓冲布局可选）。 */
function pipeline(device: GPUDevice, buffers: GPUVertexBufferLayout[] = [], label = "p") {
  return device.createRenderPipeline({
    label,
    layout: "auto",
    vertex: { module: shader(device, `${label} vs`), entryPoint: "vs", buffers },
    fragment: { module: shader(device, `${label} fs`), entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-strip" },
  });
}

function target(device: GPUDevice, label = "rt", usage = T.RENDER_ATTACHMENT | T.COPY_SRC, size = [4, 2]) {
  return device.createTexture({ label, size, format: "rgba8unorm", usage });
}

/** 一个 uniform 缓冲 + bind group；`entries` 给了就登记反射。 */
function uniformGroup(device: GPUDevice, size: number, label = "u") {
  const buffer = device.createBuffer({ label, size, usage: B.UNIFORM | B.COPY_DST });
  const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 3, buffer: {} }] });
  const group = device.createBindGroup({ label, layout, entries: [{ binding: 0, resource: { buffer } }] });
  return { buffer, group };
}

/** 编一个 pass：画一次，返回命令缓冲。 */
function onePass(
  device: GPUDevice,
  draw: (pass: GPURenderPassEncoder) => void,
  options: { label?: string; texture?: GPUTexture; encoderLabel?: string } = {},
): GPUCommandBuffer {
  const texture = options.texture ?? target(device);
  const encoder = device.createCommandEncoder({ label: options.encoderLabel ?? "enc" });
  const pass = encoder.beginRenderPass({
    label: options.label ?? "pass",
    colorAttachments: [{ view: texture.createView(), loadOp: "load", storeOp: "store" }],
  });
  draw(pass);
  pass.end();
  return encoder.finish();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("代理", () => {
  it("返回真对象，参数原样转给真对象", () => {
    const { fake, device } = setup();
    expect(device).not.toBe(fake);
    const descriptor = { label: "vb", size: 16, usage: B.VERTEX | B.COPY_DST };
    const buffer = device.createBuffer(descriptor);
    expect(buffer).toBe(fake.buffers[0]);
    expect(REAL.has(buffer)).toBe(true);
    expect(fake.descriptors.createBuffer[0]).toBe(descriptor);
    const textureDescriptor = { label: "rt", size: [4, 2], format: "rgba8unorm" as const, usage: T.RENDER_ATTACHMENT };
    const texture = device.createTexture(textureDescriptor);
    expect(texture).toBe(fake.textures[0]);
    // 不读回时纹理描述原样转（不补 COPY_SRC）
    expect(fake.descriptors.createTexture[0]).toBe(textureDescriptor);
    const view = texture.createView({ label: "v", baseMipLevel: 0 });
    expect(REAL.has(view)).toBe(true);
    const encoder = device.createCommandEncoder({ label: "enc" });
    expect(encoder).toBe(fake.encoders[0]);
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] });
    expect(pass).toBe(fake.encoders[0].passes[0]);
    const p = pipeline(device);
    expect(REAL.has(p)).toBe(true);
    pass.setPipeline(p);
    pass.setVertexBuffer(0, buffer, 4, 8);
    pass.draw(4, 1, 0, 0);
    pass.end();
    const fakePass = fake.encoders[0].passes[0];
    expect(fakePass.calls.map((c) => c.name)).toEqual(["setPipeline", "setVertexBuffer", "draw", "end"]);
    expect(fakePass.calls[0].args[0]).toBe(p);
    expect(fakePass.calls[1].args).toEqual([0, buffer, 4, 8]);
    expect(fakePass.calls[1].args[1]).toBe(buffer);
    const data = new Float32Array([1, 2, 3, 4]);
    device.queue.writeBuffer(buffer, 0, data, 1, 2);
    expect(fake.queue.writes[0]).toEqual([buffer, 0, data, 1, 2]);
    expect(fake.queue.writes[0][2]).toBe(data);
    const commandBuffer = encoder.finish();
    expect(REAL.has(commandBuffer)).toBe(true);
    device.queue.submit([commandBuffer]);
    expect(fake.queue.submitted).toEqual([commandBuffer]);
  });

  it("不认识的方法与属性原样转发，this 是真对象", async () => {
    const { fake, device } = setup();
    expect((device as unknown as FakeDevice).frobnicate(4, 2)).toBe(42);
    expect(device.limits.maxTextureDimension2D).toBe(8192);
    device.pushErrorScope("validation");
    expect(fake.scopes).toEqual(["validation"]);
    device.label = "renamed";
    expect(fake.label).toBe("renamed");
    expect(device.label).toBe("renamed");
    await device.queue.onSubmittedWorkDone();
    const encoder = device.createCommandEncoder();
    expect((encoder as unknown as FakeEncoder).pushDebugGroup("g")).toBe("group:g");
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target(device).createView(), loadOp: "load", storeOp: "store" }],
    });
    pass.insertDebugMarker("m");
    expect(fake.encoders[0].passes[0].calls[0]).toEqual({ name: "insertDebugMarker", args: ["m"] });
    // 管线的 getBindGroupLayout 是真对象自己的方法
    const layout = pipeline(device).getBindGroupLayout(0);
    expect(REAL.has(layout)).toBe(true);
  });

  it("createRenderPipelineAsync 的结果照样登记", async () => {
    const { tracer, device } = setup();
    const p = await device.createRenderPipelineAsync({
      label: "async",
      layout: "auto",
      vertex: { module: shader(device, "a vs"), entryPoint: "main" },
      fragment: { module: shader(device, "a fs"), entryPoint: "main", targets: [{ format: "rgba8unorm" }] },
    });
    expect(REAL.has(p)).toBe(true);
    tracer.startFrame();
    device.queue.submit([onePass(device, (pass) => (pass.setPipeline(p), pass.draw(3)))]);
    const { trace } = await tracer.finish();
    const id = trace.passes[0].draws[0].pipeline!;
    expect(trace.resources.pipelines[id].label).toBe("async");
    expect(trace.resources.pipelines[id].topology).toBe("triangle-list");
  });
});

describe("登记表", () => {
  it("纹理、视图、采样器、缓冲、管线、bind group 与附件", async () => {
    const { tracer, device } = setup();
    const texture = device.createTexture({
      label: "fbo",
      size: [16, 8],
      format: "rgba8unorm",
      mipLevelCount: 3,
      usage: T.TEXTURE_BINDING,
    });
    const sampler = device.createSampler({ label: "linear", magFilter: "linear", addressModeU: "repeat" });
    const { buffer, group: _ } = uniformGroup(device, 16, "layer 3 uniforms");
    const layout = device.createBindGroupLayout({ entries: [] });
    const group = device.createBindGroup({
      label: "layer 3",
      layout,
      entries: [
        { binding: 0, resource: { buffer, offset: 0, size: 16 } },
        { binding: 1, resource: texture.createView({ baseMipLevel: 1, baseArrayLayer: 0 }) },
        { binding: 2, resource: sampler },
      ],
    });
    const p = device.createRenderPipeline({
      label: "scene program 7 normal rgba8unorm",
      layout: "auto",
      vertex: {
        module: shader(device, "scene program 7 vertex"),
        entryPoint: "main",
        buffers: [{ arrayStride: 20, attributes: [{ shaderLocation: 0, format: "float32x3", offset: 0 }] }],
      },
      fragment: {
        module: shader(device, "scene program 7 fragment"),
        entryPoint: "main",
        targets: [
          {
            format: "rgba8unorm",
            blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" }, alpha: {} },
            writeMask: 7,
          },
        ],
      },
      primitive: { topology: "triangle-strip", cullMode: "back" },
      depthStencil: { format: "depth32float", depthCompare: "greater", depthWriteEnabled: false },
    });
    const rt = target(device, "scene target", T.RENDER_ATTACHMENT | T.COPY_SRC, [32, 16]);
    tracer.startFrame();
    const encoder = device.createCommandEncoder({ label: "probe frame" });
    const pass = encoder.beginRenderPass({
      label: "scene",
      colorAttachments: [
        { view: rt.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0.1, g: 0.2, b: 0.3, a: 1 } },
      ],
    });
    pass.setPipeline(p);
    pass.setBindGroup(0, group);
    pass.setScissorRect(1, 2, 3, 4);
    pass.draw(4);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const { trace } = await tracer.finish();
    expect(trace.version).toBe(1);
    const [scene] = trace.passes;
    expect(scene).toMatchObject({ index: 0, label: "scene", encoder: "probe frame", submit: 0 });
    const rtId = scene.colorAttachments[0]!.texture;
    expect(scene.colorAttachments[0]).toEqual({
      texture: rtId,
      label: "scene target",
      mip: 0,
      layer: 0,
      loadOp: "clear",
      storeOp: "store",
      clearValue: [0.1, 0.2, 0.3, 1],
    });
    expect(trace.resources.textures[rtId]).toEqual({
      label: "scene target",
      size: [32, 16, 1],
      format: "rgba8unorm",
      mipLevelCount: 1,
      usage: T.RENDER_ATTACHMENT | T.COPY_SRC,
    });
    const [draw] = scene.draws;
    expect(draw.viewport).toEqual([0, 0, 32, 16, 0, 1]);
    expect(draw.scissor).toEqual([1, 2, 3, 4]);
    expect(draw.call).toEqual({ kind: "draw", count: 4, instances: 1, first: 0, firstInstance: 0 });
    const [u, tex, smp] = draw.bindings;
    expect(u).toMatchObject({ group: 0, binding: 0, kind: "buffer", label: "layer 3 uniforms", offset: 0, size: 16 });
    expect(tex).toMatchObject({ group: 0, binding: 1, kind: "texture", label: "fbo", view: { mip: 1, layer: 0 } });
    expect(smp).toMatchObject({ group: 0, binding: 2, kind: "sampler", label: "linear" });
    expect(trace.resources.textures[tex.id]).toMatchObject({ label: "fbo", size: [16, 8, 1], mipLevelCount: 3 });
    expect(trace.resources.samplers[smp.id]).toEqual({ label: "linear", magFilter: "linear", addressModeU: "repeat" });
    expect(trace.resources.buffers[u.id]).toEqual({
      label: "layer 3 uniforms",
      size: 16,
      usage: B.UNIFORM | B.COPY_DST,
    });
    expect(trace.resources.pipelines[draw.pipeline!]).toEqual({
      label: "scene program 7 normal rgba8unorm",
      topology: "triangle-strip",
      cullMode: "back",
      frontFace: "ccw",
      vertex: [
        { arrayStride: 20, stepMode: "vertex", attributes: [{ shaderLocation: 0, format: "float32x3", offset: 0 }] },
      ],
      targets: [
        {
          format: "rgba8unorm",
          blend: {
            color: { operation: "add", srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { operation: "add", srcFactor: "one", dstFactor: "zero" },
          },
          writeMask: 7,
        },
      ],
      depth: { format: "depth32float", depthCompare: "greater", depthWriteEnabled: false, depthBias: 0 },
      shaders: [
        { stage: "vertex", module: "scene program 7 vertex", entryPoint: "main" },
        { stage: "fragment", module: "scene program 7 fragment", entryPoint: "main" },
      ],
    });
  });

  it("登记出错不影响转发与返回值；记录之外的错在 finish 时并进 errors", async () => {
    const { fake, tracer, device } = setup();
    // 顶点属性不是数组：真对象照建，记录器读描述时出错
    const broken = device.createRenderPipeline({
      label: "broken",
      layout: "auto",
      vertex: {
        module: shader(device, "b vs"),
        buffers: [{ arrayStride: 4, attributes: 5 as unknown as GPUVertexAttribute[] }],
      },
    });
    expect(REAL.has(broken)).toBe(true);
    expect(fake.descriptors.createRenderPipeline).toHaveLength(1);
    tracer.startFrame();
    device.queue.submit([onePass(device, (pass) => pass.draw(4))]);
    const { trace } = await tracer.finish();
    expect(trace.errors).toHaveLength(1);
    expect(trace.errors![0]).toMatch(/^（记录之外）/);
    // 交出之后清空
    tracer.startFrame();
    expect((await tracer.finish()).trace.errors).toBeUndefined();
  });

  it("动态偏移按 layout 里带 hasDynamicOffset 的 binding 升序加上", async () => {
    const { tracer, device } = setup();
    const buffer = device.createBuffer({ label: "ring", size: 1024, usage: B.UNIFORM | B.COPY_DST });
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 1, visibility: 3, buffer: { hasDynamicOffset: true } },
        { binding: 0, visibility: 3, buffer: { hasDynamicOffset: true } },
      ],
    });
    const group = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer, offset: 0, size: 16 } },
        { binding: 1, resource: { buffer, offset: 16, size: 16 } },
      ],
    });
    tracer.startFrame();
    device.queue.submit([
      onePass(device, (pass) => {
        pass.setPipeline(pipeline(device));
        pass.setBindGroup(0, group, new Uint32Array([9, 256, 512]), 1, 2);
        pass.draw(3);
      }),
    ]);
    const { trace } = await tracer.finish();
    const draw = trace.passes[0].draws[0];
    expect(draw.dynamicOffsets).toEqual({ 0: [256, 512] });
    expect(draw.bindings.map((b) => [b.binding, b.offset])).toEqual([
      [0, 256],
      [1, 528],
    ]);
  });

  it("startFrame 之前的 pass、draw、拷贝不记，也不读回；资源与写入照常进登记表", async () => {
    // 读回选下标 0：startFrame 之前的 pass 不算帧内的 pass 0，不该被拷出来
    const { fake, tracer, device } = setup({ readback: [0] });
    const { buffer, group } = uniformGroup(device, 16);
    device.queue.writeBuffer(buffer, 0, new Float32Array([5, 6, 7, 8]));
    const before = device.createCommandEncoder({ label: "setup" });
    before.copyBufferToBuffer(buffer, 0, buffer, 0, 0);
    device.queue.submit([before.finish(), onePass(device, (pass) => pass.draw(4), { label: "early" })]);
    tracer.startFrame();
    device.queue.submit([
      onePass(
        device,
        (pass) => {
          pass.setPipeline(pipeline(device));
          pass.setBindGroup(0, group);
          pass.draw(4);
        },
        { label: "late" },
      ),
    ]);
    const { trace } = await tracer.finish();
    expect(trace.passes.map((p) => [p.index, p.label])).toEqual([[0, "late"]]);
    expect(trace.passes[0].draws.map((d) => d.index)).toEqual([0]);
    expect(trace.copies).toEqual([]);
    expect(trace.passes[0].draws[0].rawUniforms).toEqual([{ group: 0, binding: 0, f32: [5, 6, 7, 8] }]);
    // 编码器 0 是 setup、1 是 early、2 是 late：只有 late 那个编码器里多了读回的拷贝
    expect(fake.encoders.map((e) => e.commands.filter((c) => c.kind === "copyTextureToBuffer").length)).toEqual([
      0, 0, 1,
    ]);
  });
});

describe("影子字节与提交时取值", () => {
  /** 画一次：绑 `group`，结果只看 rawUniforms（没登记反射）。 */
  async function rawUniformsOf(
    tracer: DrawTracer,
    device: GPUDevice,
    group: GPUBindGroup,
    between?: () => void,
  ): Promise<number[]> {
    tracer.startFrame();
    const commandBuffer = onePass(device, (pass) => {
      pass.setPipeline(pipeline(device));
      pass.setBindGroup(0, group);
      pass.draw(4);
    });
    between?.();
    device.queue.submit([commandBuffer]);
    const { trace } = await tracer.finish();
    return trace.passes[0].draws[0].rawUniforms![0].f32;
  }

  it("writeBuffer 的缓冲偏移与 dataOffset / size（TypedArray 按元素，ArrayBuffer 按字节）", async () => {
    const { tracer, device } = setup();
    const { buffer, group } = uniformGroup(device, 32);
    device.queue.writeBuffer(buffer, 8, new Float32Array([1, 2, 3, 4, 5]), 1, 2);
    device.queue.writeBuffer(buffer, 16, new Float32Array([10, 11, 12]).buffer, 4, 8);
    device.queue.writeBuffer(buffer, 24, new Float32Array([0, 0, 21, 22]).subarray(2));
    expect(await rawUniformsOf(tracer, device, group)).toEqual([0, 0, 2, 3, 11, 12, 21, 22]);
  });

  it("mappedAtCreation：getMappedRange 写入的内容在 unmap 时进影子（unmap 之后 ArrayBuffer 已分离）", async () => {
    const { tracer, device, fake } = setup();
    const buffer = device.createBuffer({ size: 16, usage: B.UNIFORM, mappedAtCreation: true });
    new Float32Array(buffer.getMappedRange(0, 8)).set([7, 8]);
    new Float32Array(buffer.getMappedRange(8)).set([9, 10]);
    buffer.unmap();
    expect(new Float32Array(fake.buffers[0].memory.buffer)).toEqual(new Float32Array([7, 8, 9, 10]));
    const layout = device.createBindGroupLayout({ entries: [] });
    const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer } }] });
    expect(await rawUniformsOf(tracer, device, group)).toEqual([7, 8, 9, 10]);
  });

  it("编码之后、提交之前的写入算这一帧；提交之后的不算", async () => {
    const { tracer, device } = setup();
    const { buffer, group } = uniformGroup(device, 16);
    device.queue.writeBuffer(buffer, 0, new Float32Array([1, 1, 1, 1]));
    const values = await rawUniformsOf(tracer, device, group, () =>
      device.queue.writeBuffer(buffer, 0, new Float32Array([2, 2, 2, 2])),
    );
    expect(values).toEqual([2, 2, 2, 2]);
    // 再来一帧：提交之后才写的 3 不进这一帧
    tracer.startFrame();
    device.queue.submit([
      onePass(device, (pass) => {
        pass.setPipeline(pipeline(device));
        pass.setBindGroup(0, group);
        pass.draw(4);
      }),
    ]);
    device.queue.writeBuffer(buffer, 0, new Float32Array([3, 3, 3, 3]));
    const { trace } = await tracer.finish();
    expect(trace.passes[0].draws[0].rawUniforms![0].f32).toEqual([2, 2, 2, 2]);
  });

  it("同一个命令缓冲里，copyBufferToBuffer 之后的 draw 看到拷过来的内容", async () => {
    const { tracer, device } = setup();
    const { buffer, group } = uniformGroup(device, 16);
    const staging = device.createBuffer({ label: "staging", size: 16, usage: B.COPY_SRC | B.COPY_DST });
    device.queue.writeBuffer(staging, 0, new Float32Array([4, 3, 2, 1]));
    tracer.startFrame();
    const encoder = device.createCommandEncoder();
    const view = target(device).createView();
    const drawOnce = (label: string) => {
      const pass = encoder.beginRenderPass({ label, colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] });
      pass.setPipeline(pipeline(device));
      pass.setBindGroup(0, group);
      pass.draw(4);
      pass.end();
    };
    drawOnce("before");
    encoder.copyBufferToBuffer(staging, 0, buffer, 0, 16);
    drawOnce("after");
    device.queue.submit([encoder.finish()]);
    const { trace } = await tracer.finish();
    expect(trace.passes.map((p) => p.draws[0].rawUniforms![0].f32)).toEqual([
      [0, 0, 0, 0],
      [4, 3, 2, 1],
    ]);
    expect(trace.copies).toEqual([
      { order: 1, kind: "copyBufferToBuffer", src: expect.any(String), dst: expect.any(String), size: [16, 1, 1] },
    ]);
  });

  it("到 finish() 还没提交的 pass：submit 为 null、没有取值", async () => {
    const { tracer, device } = setup();
    const { group } = uniformGroup(device, 16);
    tracer.startFrame();
    onePass(device, (pass) => {
      pass.setBindGroup(0, group);
      pass.draw(4);
    });
    const { trace } = await tracer.finish();
    expect(trace.passes[0].submit).toBeNull();
    expect(trace.passes[0].draws[0].rawUniforms).toBeUndefined();
  });
});

describe("uniform 解码", () => {
  const entries: UniformEntry[] = [
    { name: "g_Alpha", type: "f32", declared: "float", offset: 0, size: 4 },
    // vec3 按 16 字节对齐，紧跟一个 float（std140）
    { name: "g_Color", type: "vec3<f32>", declared: "vec3", offset: 16, size: 12 },
    { name: "g_After", type: "f32", declared: "float", offset: 28, size: 4 },
    { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 32, size: 64 },
    // vec2 数组补成 vec4 数组，步长 16，只取前两个分量
    { name: "g_Points", type: "array<vec4<f32>, 3>", declared: "vec2", offset: 96, size: 48, array: 3, stride: 16 },
    // mat3 列步长 16
    { name: "g_Normal", type: "mat3x3<f32>", declared: "mat3", offset: 144, size: 48 },
    { name: "g_Count", type: "i32", declared: "int", offset: 192, size: 4 },
  ];
  const values: Record<string, number[]> = {
    g_Alpha: [0.25],
    g_Color: [0.1, 0.2, 0.3],
    g_After: [7],
    g_ModelViewProjectionMatrix: Array.from({ length: 16 }, (_, i) => i * 0.5 - 3),
    g_Points: [1, 2, 3, 4, 5, 6],
    g_Normal: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    g_Count: [-5],
  };
  const block = () => {
    const block = new UniformBlock(entries, 208);
    for (const [name, value] of Object.entries(values)) block.set(name, value);
    return block;
  };
  const expected = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      value.length === 1 ? Math.fround(value[0]) : value.map((v) => Math.fround(v)),
    ]),
  );

  it("按反射解码：标量、vec3 的 16 字节对齐、mat4、数组步长、mat3 列步长、整数（和 UniformBlock 的写法互逆）", () => {
    expect(decodeUniforms(entries, new Uint8Array(block().data))).toEqual(expected);
  });

  it("登记过反射的 uniform 缓冲在轨迹里按名字解码", async () => {
    vi.stubGlobal("__SCENE_DEV__", true);
    const { tracer, device } = setup();
    const { buffer, group } = uniformGroup(device, 208, "layer 179 text glyphs");
    traceUniforms(buffer, entries);
    device.queue.writeBuffer(buffer, 0, block().data);
    tracer.startFrame();
    device.queue.submit([
      onePass(device, (pass) => {
        pass.setPipeline(pipeline(device));
        pass.setBindGroup(0, group);
        pass.draw(4);
      }),
    ]);
    const { trace } = await tracer.finish();
    const draw = trace.passes[0].draws[0];
    expect(draw.uniforms).toEqual(expected);
    expect(draw.rawUniforms).toBeUndefined();
  });

  it("非 dev 构建（__SCENE_DEV__ 为假）traceUniforms 是空操作：没登记，给原始 float32", async () => {
    vi.stubGlobal("__SCENE_DEV__", false);
    const { tracer, device } = setup();
    const { buffer, group } = uniformGroup(device, 16);
    traceUniforms(buffer, [{ name: "g_Alpha", type: "f32", offset: 0, size: 4 }]);
    device.queue.writeBuffer(buffer, 0, new Float32Array([0.5, 1, 2, 3]));
    tracer.startFrame();
    device.queue.submit([
      onePass(device, (pass) => {
        pass.setPipeline(pipeline(device));
        pass.setBindGroup(0, group);
        pass.draw(4);
      }),
    ]);
    const { trace } = await tracer.finish();
    expect(trace.passes[0].draws[0].uniforms).toBeUndefined();
    expect(trace.passes[0].draws[0].rawUniforms).toEqual([{ group: 0, binding: 0, f32: [0.5, 1, 2, 3] }]);
  });
});

describe("顶点与索引", () => {
  const layouts: GPUVertexBufferLayout[] = [
    {
      arrayStride: 28,
      attributes: [
        { shaderLocation: 0, format: "float32x3", offset: 0 },
        { shaderLocation: 1, format: "float32x2", offset: 12 },
        { shaderLocation: 2, format: "unorm8x4", offset: 20 },
        { shaderLocation: 3, format: "uint32", offset: 24 },
      ],
    },
    { arrayStride: 16, stepMode: "instance", attributes: [{ shaderLocation: 4, format: "float32x4", offset: 0 }] },
  ];
  /** 第 i 个顶点：位置 (i, 10i, 100i)、uv (i/2, 1)、颜色 (i, 255, 0, 128)、id 1000 + i。 */
  function vertexData(count: number): ArrayBuffer {
    const data = new ArrayBuffer(28 * count);
    const view = new DataView(data);
    for (let i = 0; i < count; i++) {
      const at = i * 28;
      [i, 10 * i, 100 * i, i / 2, 1].forEach((v, k) => view.setFloat32(at + k * 4, v, true));
      [i, 255, 0, 128].forEach((v, k) => view.setUint8(at + 20 + k, v));
      view.setUint32(at + 24, 1000 + i, true);
    }
    return data;
  }
  const row = (i: number) => ({
    "loc0:float32x3": [i, 10 * i, 100 * i],
    "loc1:float32x2": [i / 2, 1],
    "loc2:unorm8x4": [i / 255, 1, 0, 128 / 255],
    "loc3:uint32": [1000 + i],
  });
  const rows = (indices: number[]) => {
    const out: Record<string, number[][]> = {};
    for (const i of indices) for (const [key, value] of Object.entries(row(i))) (out[key] ??= []).push(value);
    return out;
  };

  function setupGeometry(options?: TraceOptions) {
    const { tracer, device } = setup(options);
    const vertices = device.createBuffer({ label: "quad", size: 28 * 8, usage: B.VERTEX | B.COPY_DST });
    device.queue.writeBuffer(vertices, 0, vertexData(8));
    const instances = device.createBuffer({ label: "inst", size: 64, usage: B.VERTEX | B.COPY_DST });
    device.queue.writeBuffer(instances, 0, new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
    return { tracer, device, vertices, instances, p: pipeline(device, layouts, "mesh") };
  }

  it("按管线的顶点布局解码：float32x2/x3、unorm8x4、uint32；按实例步进的属性按实例号取", async () => {
    const { tracer, device, vertices, instances, p } = setupGeometry();
    tracer.startFrame();
    device.queue.submit([
      onePass(device, (pass) => {
        pass.setPipeline(p);
        pass.setVertexBuffer(0, vertices);
        pass.setVertexBuffer(1, instances, 16);
        pass.draw(3, 2, 1, 0);
      }),
    ]);
    const { trace } = await tracer.finish();
    const draw = trace.passes[0].draws[0];
    expect(draw.indices).toBeUndefined();
    expect(draw.vertices).toEqual({
      ...rows([1, 2, 3]),
      "loc4:float32x4@instance": [
        [5, 6, 7, 8],
        [9, 10, 11, 12],
      ],
    });
    expect(draw.vertexBuffers).toEqual([
      { slot: 0, id: expect.any(String), label: "quad", offset: 0, size: 224 },
      { slot: 1, id: expect.any(String), label: "inst", offset: 16, size: 48 },
    ]);
  });

  it("uint16 / uint32 索引：从 firstIndex 起取，顶点按 索引 + baseVertex；行数到 maxVertices 为止", async () => {
    const { tracer, device, vertices, p } = setupGeometry({ maxVertices: 3 });
    const index16 = device.createBuffer({ label: "i16", size: 16, usage: B.INDEX | B.COPY_DST });
    device.queue.writeBuffer(index16, 0, new Uint16Array([9, 9, 0, 2, 1, 3, 0, 0]));
    const index32 = device.createBuffer({ label: "i32", size: 16, usage: B.INDEX | B.COPY_DST });
    device.queue.writeBuffer(index32, 0, new Uint32Array([4, 0, 1, 2]));
    tracer.startFrame();
    device.queue.submit([
      onePass(device, (pass) => {
        pass.setPipeline(p);
        pass.setVertexBuffer(0, vertices);
        pass.setIndexBuffer(index16, "uint16");
        pass.drawIndexed(4, 1, 2, 1);
        pass.setIndexBuffer(index32, "uint32", 4);
        pass.drawIndexed(2, 1, 1, 3);
      }),
    ]);
    const { trace } = await tracer.finish();
    const [a, b] = trace.passes[0].draws;
    expect(a.call).toEqual({ kind: "drawIndexed", count: 4, instances: 1, first: 2, baseVertex: 1, firstInstance: 0 });
    expect(a.indices).toEqual([0, 2, 1]);
    expect(a.vertices).toEqual(rows([1, 3, 2]));
    expect(a.indexBuffer).toEqual({ id: expect.any(String), label: "i16", format: "uint16", offset: 0, size: 16 });
    // 偏移 4 字节的 uint32 缓冲：[0, 1, 2]，firstIndex 1 → 1、2
    expect(b.indices).toEqual([1, 2]);
    expect(b.vertices).toEqual(rows([4, 5]));
  });

  it("readVertexAttribute：半精度、snorm、10-10-10-2、bgra、越界与不认识的格式", () => {
    const view = new DataView(new ArrayBuffer(8));
    view.setUint16(0, 0x3c00, true); // 1.0
    view.setUint16(2, 0xc000, true); // -2.0
    expect(readVertexAttribute(view, 0, "float16x2")).toEqual([1, -2]);
    view.setInt8(4, -128);
    view.setInt8(5, 127);
    expect(readVertexAttribute(view, 4, "snorm8x2")).toEqual([-1, 1]);
    view.setUint32(4, 1023 | (0 << 10) | (512 << 20) | (3 << 30), true);
    expect(readVertexAttribute(view, 4, "unorm10-10-10-2")).toEqual([1, 0, 512 / 1023, 1]);
    view.setUint32(4, 0x04030201, true);
    expect(readVertexAttribute(view, 4, "unorm8x4-bgra")).toEqual([3 / 255, 2 / 255, 1 / 255, 4 / 255]);
    expect(readVertexAttribute(view, 4, "float32x2")).toEqual([view.getFloat32(4, true), NaN]);
    expect(readVertexAttribute(view, 0, "nope")).toBeNull();
  });
});

describe("读回", () => {
  it("按下标与标签子串（pass 标签或附件纹理标签）选中；补 COPY_SRC；读回颜色附件 0 那一级", async () => {
    const { fake, tracer, device } = setup({ readback: [1, "glyphs"] });
    const plain = device.createTexture({ label: "a", size: [2, 1], format: "rgba8unorm", usage: T.RENDER_ATTACHMENT });
    const composite = device.createTexture({
      label: "layer 179 composite",
      size: [8, 4],
      mipLevelCount: 2,
      format: "rgba8unorm",
      usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING,
    });
    const hdr = device.createTexture({
      label: "text glyphs rt",
      size: [2, 1],
      format: "rgba16float",
      usage: T.RENDER_ATTACHMENT,
    });
    const depth = device.createTexture({
      label: "d",
      size: [2, 1],
      format: "depth32float",
      usage: T.RENDER_ATTACHMENT,
    });
    const sampled = device.createTexture({
      label: "img",
      size: [2, 1],
      format: "rgba8unorm",
      usage: T.TEXTURE_BINDING,
    });
    // 渲染器要的用途只补 COPY_SRC：颜色附件补，深度、不是附件的不补；轨迹里记渲染器要的那份
    const usages = fake.descriptors.createTexture.map((d) => (d as GPUTextureDescriptor).usage);
    expect(usages).toEqual([
      T.RENDER_ATTACHMENT | T.COPY_SRC,
      T.RENDER_ATTACHMENT | T.TEXTURE_BINDING | T.COPY_SRC,
      T.RENDER_ATTACHMENT | T.COPY_SRC,
      T.RENDER_ATTACHMENT,
      T.TEXTURE_BINDING,
    ]);
    void depth;
    void sampled;
    // mip 1 是 4×2：内容按 mip 0 的 8 列排，假设备拷每行前 4 个纹素
    fake.textures[1].content = Uint8Array.from({ length: 8 * 4 * 4 }, (_, i) => i % 251);
    const halves = new Uint16Array([0x3c00, 0x3800, 0, 0xbc00, 0x4000, 0x3c00, 0x3c00, 0x3c00]);
    fake.textures[2].content = new Uint8Array(halves.buffer);
    tracer.startFrame();
    const encoder = device.createCommandEncoder({ label: "probe frame" });
    for (const [label, view] of [
      ["p0", plain.createView()],
      ["p1", composite.createView({ baseMipLevel: 1, mipLevelCount: 1 })],
      ["p2", hdr.createView()],
      ["p3", plain.createView()],
    ] as const) {
      encoder.beginRenderPass({ label, colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] }).end();
    }
    device.queue.submit([encoder.finish()]);
    expect(fake.queue.errors).toEqual([]);
    const { trace, readbacks } = await tracer.finish();
    expect(readbacks.map((r) => [r.pass, r.label, r.width, r.height, r.format, r.kind])).toEqual([
      [1, "p1", 4, 2, "rgba8unorm", "rgba8"],
      [2, "p2", 2, 1, "rgba16float", "f32"],
    ]);
    const mip1 = fake.textures[1].content!;
    expect(Array.from(readbacks[0].data)).toEqual([...mip1.subarray(0, 16), ...mip1.subarray(32, 48)]);
    expect(Array.from(readbacks[1].data)).toEqual([1, 0.5, 0, -1, 2, 1, 1, 1]);
    expect(trace.resources.textures[trace.passes[1].colorAttachments[0]!.texture].usage).toBe(
      T.RENDER_ATTACHMENT | T.TEXTURE_BINDING,
    );
    expect(trace.passes.map((p) => p.readbackError ?? null)).toEqual([null, null, null, null]);
    // 读回缓冲用完就销毁
    expect(fake.buffers.filter((b) => b.descriptor.usage & B.MAP_READ).every((b) => b.destroyed)).toBe(true);
  });

  it("选中了却读不了：格式不认识、附件纹理不是经记录器建的、命令缓冲没提交，pass 里写原因、不拷", async () => {
    // 第 1 个 pass 的附件不经记录器建、认不出纹理标签，按下标选
    const { fake, tracer, device } = setup({ readback: ["x", 1] });
    const r8 = device.createTexture({ label: "x r8", size: [2, 2], format: "r8unorm", usage: T.RENDER_ATTACHMENT });
    // 不经记录器建的纹理（没补 COPY_SRC）：真 WebGPU 拷它会让整个命令缓冲无效
    const outside = (fake as unknown as GPUDevice).createTexture({
      label: "x outside",
      size: [2, 2],
      format: "rgba8unorm",
      usage: T.RENDER_ATTACHMENT,
    });
    tracer.startFrame();
    const encoder = device.createCommandEncoder();
    encoder.beginRenderPass({ colorAttachments: [{ view: r8.createView(), loadOp: "load", storeOp: "store" }] }).end();
    encoder
      .beginRenderPass({ colorAttachments: [{ view: outside.createView(), loadOp: "load", storeOp: "store" }] })
      .end();
    device.queue.submit([encoder.finish()]);
    const pending = device.createCommandEncoder();
    const rt = target(device, "x late", T.RENDER_ATTACHMENT);
    pending.beginRenderPass({ colorAttachments: [{ view: rt.createView(), loadOp: "load", storeOp: "store" }] }).end();
    pending.finish();
    expect(fake.queue.errors).toEqual([]);
    const { trace, readbacks } = await tracer.finish();
    expect(readbacks).toEqual([]);
    expect(trace.passes[0].readbackError).toMatch(/r8unorm/);
    expect(trace.passes[1].readbackError).toMatch(/不是经记录器建的/);
    expect(trace.passes[2].readbackError).toMatch(/还没提交/);
  });

  it("convertReadback：去掉行填充，bgra 换成 rgba", () => {
    const raw = new Uint8Array(512);
    raw.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
    raw.set([9, 10, 11, 12, 13, 14, 15, 16], 256);
    expect(Array.from(convertReadback(raw, "rgba8unorm", 2, 2, 256).data)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    expect(Array.from(convertReadback(raw, "bgra8unorm", 2, 1, 256).data)).toEqual([3, 2, 1, 4, 7, 6, 5, 8]);
  });
});
