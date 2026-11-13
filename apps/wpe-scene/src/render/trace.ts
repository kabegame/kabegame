/**
 * 场景渲染器的逐 draw 轨迹（dev 探针用，`.claude/plans/tools/scene-draw-trace.md`）：渲染一帧时记下每个 render pass、每个 draw 的
 * 管线、绑定、uniform、顶点，用来和 WPE 的 RenderDoc 抓帧逐 draw 对照。
 *
 * `createDrawTracer(device)` 给出一个包过的设备，渲染器拿它建资源、编码。包的方式：
 * - 设备与队列是 `Proxy`：认识的调用（建资源、编码器、`writeBuffer`、`submit` 等）先原样转给真对象，再把看到的东西记进登记表；
 *   不认识的方法原样转发（`this` 是真对象）。这两个代理自己从不交给 WebGPU：WebGPU 对参数做品牌检查，代理会被拒。
 * - 建出来的纹理、缓冲、命令编码器、render pass 都是**真对象**，原样返回、可以照常交给 WebGPU；要记录的方法（`createView`、
 *   `getMappedRange` / `unmap`、`beginRenderPass`、`copy*`、`finish`、pass 的 `set*` / `draw*` / `end`）只在这个实例上加同名的自有
 *   方法，转调原型上的原方法。不改全局原型，同一页面里别的设备（实时宿主）不受影响。
 *
 * 登记表按真对象存（`WeakMap`）：缓冲的描述与影子字节（`queue.writeBuffer`、`mappedAtCreation` / 映射写入同步进来，命令缓冲里的
 * `copyBufferToBuffer` / `clearBuffer` 在提交时按顺序应用），纹理、视图、采样器、着色器模块、管线、bind group layout 与 bind group。
 * `startFrame()` 之前只进登记表，之后才记 pass、draw 与拷贝。draw 引用的缓冲内容在 `queue.submit` 那一刻从影子里取：WebGPU 里提交前
 * 的写入对这次提交的全部 draw 可见，编码之后、提交之前的写入也算，提交之后的写入不算。
 *
 * 解码：登记过反射（`traceUniforms`，建 uniform 缓冲处调）的 uniform 缓冲按名字解码，规则同 `UniformBlock`；没登记的按 float32
 * 原样给。顶点按管线的顶点缓冲布局解码，带索引时先解码索引，每个 draw 取前 `maxVertices` 个被引用的顶点（同 RenderDoc 的 `vs_in`
 * 按行列出，索引重复的照样重复）。
 *
 * 读回：`readback` 选中的 pass（下标，或 pass 标签 / 颜色附件 0 的纹理标签里的子串）结束后，在同一个编码器里把颜色附件 0 拷进读回
 * 缓冲，`finish()` 时映射取出。要读回时，带 RENDER_ATTACHMENT 的颜色纹理在建的时候补上 COPY_SRC（场景的目标本来都有）；纹理没有
 * COPY_SRC 或格式不认识时不拷（拷了会让整个命令缓冲无效），pass 里写明原因。
 *
 * 记录出错（解码越界等）只记进轨迹的 `errors`，不影响转发，渲染路径与不包设备时相同。
 */
import { declaredComponents, parseShape, type UniformEntry } from "./uniforms";

// WebGPU 规范里的位值。不读全局 `GPUBufferUsage` 等：Node 单测里没有这些全局，部分单测还按别的值打桩
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_UNIFORM = 0x0040;
const TEXTURE_COPY_SRC = 0x01;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const MAP_MODE_READ = 0x0001;

/** 每个 draw 缺省解码这么多个被引用的顶点（同 RenderDoc 的 `vs_in` 常看的前几十行）。 */
export const DEFAULT_TRACE_VERTICES = 64;
/** `maxVertices` 的上限（REST 同样限制）。 */
export const MAX_TRACE_VERTICES = 4096;

export interface TraceOptions {
  /** 选哪些 pass 在结束后读回目标：pass 下标，或 pass 标签 / 目标纹理标签里的子串；缺省不读回。 */
  readback?: (number | string)[];
  /** 每个 draw 解码多少个被引用的顶点（缺省 64，钳到 0–4096；探针与 REST 只收 1–4096）。 */
  maxVertices?: number;
}

export interface TraceVertexLayout {
  arrayStride: number;
  stepMode: string;
  attributes: { shaderLocation: number; format: string; offset: number }[];
}

export interface TraceTexture {
  label: string;
  size: number[];
  format: string;
  mipLevelCount: number;
  /** 渲染器要的用途（读回时补的 COPY_SRC 不算在内）。 */
  usage: number;
  dimension?: string;
  sampleCount?: number;
}

export interface TraceBuffer {
  label: string;
  size: number;
  usage: number;
}

export type TraceSampler = { label: string } & Record<string, unknown>;

export interface TracePipeline {
  label: string;
  topology: string;
  cullMode: string;
  frontFace: string;
  vertex: (TraceVertexLayout | null)[];
  targets: ({ format: string; blend?: GPUBlendState; writeMask: number } | null)[];
  depth?: Record<string, unknown>;
  shaders: { stage: string; module: string; entryPoint: string }[];
}

export interface TraceAttachment {
  texture: string;
  label: string;
  mip: number;
  layer: number;
  loadOp: string;
  storeOp: string;
  clearValue?: number[];
}

export interface TraceBinding {
  group: number;
  binding: number;
  kind: "buffer" | "texture" | "sampler" | "other";
  id: string;
  label: string;
  offset?: number;
  size?: number;
  view?: { mip: number; layer: number };
}

export interface TraceDraw {
  /** 帧内全局序号（编码顺序）。 */
  index: number;
  pipeline: string | null;
  /** 生效的视口 `[x, y, w, h, minDepth, maxDepth]`：没设时是附件整张。 */
  viewport?: number[];
  /** 生效的裁剪 `[x, y, w, h]`：没设时是附件整张。 */
  scissor?: number[];
  blendConstant?: number[];
  stencilReference?: number;
  call: {
    kind: "draw" | "drawIndexed" | "drawIndirect" | "drawIndexedIndirect";
    count: number;
    instances: number;
    first: number;
    baseVertex?: number;
    firstInstance: number;
  };
  bindings: TraceBinding[];
  /** `setBindGroup` 给的动态偏移，按组号。 */
  dynamicOffsets?: Record<number, number[]>;
  vertexBuffers?: { slot: number; id: string; label: string; offset: number; size: number }[];
  indexBuffer?: { id: string; label: string; format: string; offset: number; size: number };
  /** 登记过反射的 uniform 缓冲，按名字解码（标量是数，其余是按声明分量展平的数组，矩阵列主序）。 */
  uniforms?: Record<string, number | number[]>;
  /** 没登记反射的 uniform 缓冲：按 float32 原样给。 */
  rawUniforms?: { group: number; binding: number; f32: number[] }[];
  /** 前 `maxVertices` 个索引（原值，不加 `baseVertex`）。 */
  indices?: number[];
  /**
   * 前 `maxVertices` 个被引用的顶点，按属性：键是 `loc<location>:<格式>`，按实例步进的属性另加 `@instance`（按实例号取前
   * `maxVertices` 个）。行和 `indices` 一一对应（没有索引时是 `first` 起的连续顶点）。
   */
  vertices?: Record<string, number[][]>;
}

export interface TracePass {
  /** 帧内序号（`beginRenderPass` 的顺序）。 */
  index: number;
  label: string;
  /** 所在命令编码器的标签。 */
  encoder: string;
  /** 帧内第几次 `queue.submit` 提交了它（从 0 起）；到 `finish()` 还没提交为 null，这时 draw 没有取值。 */
  submit: number | null;
  colorAttachments: (TraceAttachment | null)[];
  depthAttachment?: Record<string, unknown>;
  draws: TraceDraw[];
  /** 读回的图在存放区的键（探针填）。 */
  readback?: string;
  /** 选中了却没读回的原因。 */
  readbackError?: string;
}

export interface TraceCopy {
  /** 这次拷贝之前帧内已开始了几个 pass（编码 / 调用顺序）。 */
  order: number;
  /** `copyTextureToTexture` 等；队列上的写入带 `queue.` 前缀。 */
  kind: string;
  src: string;
  dst: string;
  size: number[];
}

export interface DrawTrace {
  version: 1;
  /** 这一帧引用到的资源，ID 在一个记录器里按创建顺序编号，标签照抄。 */
  resources: {
    textures: Record<string, TraceTexture>;
    buffers: Record<string, TraceBuffer>;
    samplers: Record<string, TraceSampler>;
    pipelines: Record<string, TracePipeline>;
  };
  passes: TracePass[];
  copies: TraceCopy[];
  /** 记录器自己出的错（不影响渲染）。 */
  errors?: string[];
}

export interface TraceReadback {
  pass: number;
  label: string;
  texture: string;
  width: number;
  height: number;
  format: string;
  /** `rgba8`：RGBA 字节（bgra 已换成 rgba）；`f32`：RGBA 单精度（半精度已展开）。 */
  kind: "rgba8" | "f32";
  data: Uint8Array | Float32Array;
}

export interface DrawTracer {
  /** 包过的设备：建资源、编码都用它；返回的都是真对象。 */
  device: GPUDevice;
  /** 从现在起记 pass 与 draw（之前的只进登记表）；探针在读回帧编码之前调。 */
  startFrame(): void;
  /** 停止记录，等读回完成，给出这一帧的轨迹与读回的图。 */
  finish(): Promise<{ trace: DrawTrace; readbacks: TraceReadback[] }>;
}

/** 建 uniform 缓冲处登记的反射，按真缓冲存。 */
const uniformReflections = new WeakMap<object, readonly UniformEntry[]>();

/**
 * 建 uniform 缓冲处登记反射（`render/scene.ts`、`render/bloom.ts`），记录器按它解码。非 dev 构建（`__SCENE_DEV__` 为假）是空操作，
 * 不保留引用；单测里没定义这个常量时同样是空操作。
 */
export function traceUniforms(buffer: GPUBuffer, entries: readonly UniformEntry[]): void {
  if (typeof __SCENE_DEV__ === "undefined" || !__SCENE_DEV__) return;
  uniformReflections.set(buffer, entries);
}

/** 按反射解码一块 uniform 字节（规则同 `UniformBlock.set` 的写法：偏移、数组步长、矩阵列步长、声明分量数）。 */
export function decodeUniforms(entries: readonly UniformEntry[], bytes: Uint8Array): Record<string, number | number[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, number | number[]> = {};
  for (const entry of entries) {
    const shape = parseShape(entry.type);
    const count = entry.array ?? 1;
    const stride = entry.stride ?? entry.size;
    const elementSize = count > 1 ? stride : entry.size;
    const columnStride =
      shape.rows === 3 ? 16 : shape.columns > 1 ? Math.max(4 * shape.rows, Math.floor(elementSize / shape.columns)) : 0;
    const components = declaredComponents(entry.declared, shape);
    const read = (at: number): number => {
      if (at < 0 || at + 4 > bytes.byteLength) return NaN;
      if (shape.scalar === "i32") return view.getInt32(at, true);
      if (shape.scalar === "u32") return view.getUint32(at, true);
      return view.getFloat32(at, true);
    };
    const values: number[] = [];
    for (let element = 0; element < count; element++) {
      const base = entry.offset + element * stride;
      if (shape.columns > 1) {
        for (let c = 0; c < shape.columns; c++)
          for (let r = 0; r < shape.rows; r++) values.push(read(base + c * columnStride + r * 4));
      } else {
        const n = Math.min(components, shape.rows);
        for (let k = 0; k < n; k++) values.push(read(base + k * 4));
      }
    }
    out[entry.name] = count === 1 && values.length === 1 ? values[0] : values;
  }
  return out;
}

/** IEEE 754 半精度 → 单精度（同 `dev/probe.ts` 的 `halfToFloat`；渲染模块不引 dev 代码，这里另写一份）。 */
function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** 读一个顶点属性；格式不认识时 null，越界的分量为 NaN。 */
export function readVertexAttribute(view: DataView, at: number, format: string): number[] | null {
  const inside = (bytes: number) => at >= 0 && at + bytes <= view.byteLength;
  if (format === "unorm10-10-10-2") {
    if (!inside(4)) return [NaN, NaN, NaN, NaN];
    const v = view.getUint32(at, true);
    return [(v & 1023) / 1023, ((v >> 10) & 1023) / 1023, ((v >> 20) & 1023) / 1023, ((v >>> 30) & 3) / 3];
  }
  if (format === "unorm8x4-bgra") {
    if (!inside(4)) return [NaN, NaN, NaN, NaN];
    return [2, 1, 0, 3].map((i) => view.getUint8(at + i) / 255);
  }
  const m = /^(uint|sint|unorm|snorm|float)(8|16|32)(?:x([234]))?$/.exec(format);
  if (!m) return null;
  const kind = m[1];
  const bytes = Number(m[2]) / 8;
  const n = m[3] ? Number(m[3]) : 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = at + i * bytes;
    if (p < 0 || p + bytes > view.byteLength) {
      out.push(NaN);
      continue;
    }
    if (kind === "float") out.push(bytes === 2 ? halfToFloat(view.getUint16(p, true)) : view.getFloat32(p, true));
    else if (kind === "uint")
      out.push(bytes === 1 ? view.getUint8(p) : bytes === 2 ? view.getUint16(p, true) : view.getUint32(p, true));
    else if (kind === "sint")
      out.push(bytes === 1 ? view.getInt8(p) : bytes === 2 ? view.getInt16(p, true) : view.getInt32(p, true));
    else if (kind === "unorm") out.push(bytes === 1 ? view.getUint8(p) / 255 : view.getUint16(p, true) / 65535);
    else out.push(Math.max(-1, bytes === 1 ? view.getInt8(p) / 127 : view.getInt16(p, true) / 32767));
  }
  return out;
}

// ---------------------------------------------------------------- 登记表

interface BufferInfo {
  id: string;
  label: string;
  size: number;
  usage: number;
  object: GPUBuffer;
  /** 影子字节：第一次写入时建（WebGPU 的缓冲建出来是 0）；不经记录器建的缓冲没有。 */
  shadow: Uint8Array | null;
  tracked: boolean;
  /** `getMappedRange` 给出去的区间，`unmap` 之前拷进影子。 */
  mapped: { offset: number; range: ArrayBuffer }[];
}

interface TextureInfo {
  id: string;
  label: string;
  size: [number, number, number];
  format: string;
  mipLevelCount: number;
  sampleCount: number;
  dimension: string;
  usage: number;
  /** 真纹理的用途（读回时可能补了 COPY_SRC）。 */
  actualUsage: number;
  object: GPUTexture;
}

interface ViewInfo {
  texture: TextureInfo | null;
  label: string;
  mip: number;
  layer: number;
}

interface SamplerInfo {
  id: string;
  label: string;
  descriptor: Record<string, unknown>;
}

interface PipelineInfo {
  id: string;
  json: TracePipeline;
}

/** bind group layout：带动态偏移的 binding 号（升序，`setBindGroup` 的动态偏移按这个顺序对应）。 */
interface LayoutInfo {
  dynamic: number[];
}

type EntryInfo =
  | { binding: number; kind: "buffer"; buffer: BufferInfo; offset: number; size: number | undefined }
  | { binding: number; kind: "texture"; view: ViewInfo }
  | { binding: number; kind: "sampler"; sampler: SamplerInfo }
  | { binding: number; kind: "other"; label: string };

interface BindGroupInfo {
  id: string;
  label: string;
  layout: LayoutInfo | null;
  entries: EntryInfo[];
}

interface BufferRange {
  buffer: BufferInfo;
  offset: number;
  size: number;
}

interface DrawRecord {
  json: TraceDraw;
  pipeline: PipelineInfo | null;
  uniforms: (BufferRange & { group: number; binding: number })[];
  vertex: Map<number, BufferRange>;
  index: (BufferRange & { format: GPUIndexFormat }) | null;
  resolved: boolean;
}

interface PassRecord {
  json: TracePass;
  draws: DrawRecord[];
  /** 颜色附件 0（或深度附件）那一级的尺寸：缺省视口与裁剪。 */
  size: [number, number] | null;
  attachment: ViewInfo | null;
}

interface PendingReadback {
  pass: PassRecord;
  texture: TextureInfo;
  buffer: GPUBuffer;
  width: number;
  height: number;
  bytesPerRow: number;
  encoder: EncoderRecord;
}

type EncoderEvent =
  | { kind: "pass"; pass: PassRecord }
  | {
      kind: "copy-buffer";
      src: BufferInfo | null;
      srcOffset: number;
      dst: BufferInfo | null;
      dstOffset: number;
      size: number;
    }
  | { kind: "clear-buffer"; buffer: BufferInfo | null; offset: number; size: number | undefined };

interface EncoderRecord {
  label: string;
  events: EncoderEvent[];
  submitted: boolean;
  /** 原型上的 `copyTextureToBuffer`，读回时用（不进轨迹的拷贝表）。 */
  copyTextureToBuffer: (
    source: GPUTexelCopyTextureInfo,
    destination: GPUTexelCopyBufferInfo,
    size: GPUExtent3D,
  ) => void;
}

interface Frame {
  passes: PassRecord[];
  copies: TraceCopy[];
  draws: number;
  submits: number;
  readbacks: PendingReadback[];
  errors: string[];
  /** 这一帧的 pass、draw、拷贝引用到的资源：轨迹的 `resources` 只列这些。 */
  textures: Set<TextureInfo>;
  buffers: Set<BufferInfo>;
  samplers: Set<SamplerInfo>;
  pipelines: Set<PipelineInfo>;
}

type Fn = (...args: never[]) => unknown;

/** 在实例上加同名的自有方法（不碰原型）；`make` 拿到原型上的原方法，自己负责以真对象为 `this` 转调。 */
function patch(target: object, name: string, make: (original: Fn) => Fn): void {
  const original = (target as Record<string, unknown>)[name];
  if (typeof original !== "function") return;
  Object.defineProperty(target, name, {
    value: make(original as Fn),
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

const call = (original: Fn, self: object, args: unknown[]): unknown =>
  (original as unknown as (...a: unknown[]) => unknown).apply(self, args);

/**
 * 转发用的代理：`overrides` 里的属性给记录器的实现，其余照读真对象（getter 的 `this` 是真对象），方法以真对象为 `this` 调用，
 * 写属性也写到真对象上。
 */
function forwardingProxy<T extends object>(target: T, overrides: Record<string, unknown>): T {
  const bound = new Map<PropertyKey, { original: Fn; fn: Fn }>();
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const value = Reflect.get(t, prop, t) as unknown;
      if (typeof value !== "function") return value;
      let entry = bound.get(prop);
      if (!entry || entry.original !== value) {
        const original = value as Fn;
        entry = { original, fn: ((...args: unknown[]) => call(original, t, args)) as Fn };
        bound.set(prop, entry);
      }
      return entry.fn;
    },
    set(t, prop, value) {
      return Reflect.set(t, prop, value, t);
    },
  });
}

const isIterable = (value: unknown): value is Iterable<number> =>
  !!value && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";

function extent(size: GPUExtent3D | undefined): [number, number, number] {
  if (!size) return [0, 0, 0];
  if (isIterable(size)) {
    const [w = 0, h = 1, d = 1] = Array.from(size);
    return [w, h, d];
  }
  const s = size as GPUExtent3DDict;
  return [s.width, s.height ?? 1, s.depthOrArrayLayers ?? 1];
}

function color(value: GPUColor | undefined): number[] {
  if (!value) return [0, 0, 0, 0];
  if (isIterable(value)) return Array.from(value);
  const c = value as GPUColorDict;
  return [c.r, c.g, c.b, c.a];
}

/** `writeBuffer` 的数据源 → 字节（`dataOffset` / `size` 对 TypedArray 按元素、对 ArrayBuffer 与 DataView 按字节）。 */
function sourceBytes(data: unknown, dataOffset = 0, size?: number): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    const element = (data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
    const start = data.byteOffset + dataOffset * element;
    const length = size === undefined ? data.byteLength - dataOffset * element : size * element;
    return new Uint8Array(data.buffer, start, length);
  }
  const buffer = data as ArrayBuffer;
  return new Uint8Array(buffer, dataOffset, size ?? buffer.byteLength - dataOffset);
}

/** 读回支持的格式：每纹素字节数与结果种类。 */
const READBACK_FORMATS: Record<string, { texel: number; kind: "rgba8" | "f32" }> = {
  rgba8unorm: { texel: 4, kind: "rgba8" },
  "rgba8unorm-srgb": { texel: 4, kind: "rgba8" },
  bgra8unorm: { texel: 4, kind: "rgba8" },
  "bgra8unorm-srgb": { texel: 4, kind: "rgba8" },
  rgba16float: { texel: 8, kind: "f32" },
  rgba32float: { texel: 16, kind: "f32" },
};

const isDepthFormat = (format: string) => format.startsWith("depth") || format.startsWith("stencil");

class Tracer {
  private readonly readback: (number | string)[];
  private readonly maxVertices: number;
  private readonly addCopySrc: boolean;
  private readonly buffers = new WeakMap<object, BufferInfo>();
  private readonly textures = new WeakMap<object, TextureInfo>();
  private readonly views = new WeakMap<object, ViewInfo>();
  private readonly samplers = new WeakMap<object, SamplerInfo>();
  private readonly modules = new WeakMap<object, { label: string }>();
  private readonly pipelines = new WeakMap<object, PipelineInfo>();
  private readonly layouts = new WeakMap<object, LayoutInfo>();
  private readonly bindGroups = new WeakMap<object, BindGroupInfo>();
  private readonly commandBuffers = new WeakMap<object, EncoderRecord>();
  private readonly counters = new Map<string, number>();
  private recording = false;
  private frame: Frame = Tracer.emptyFrame();
  /** 不在记录时（建场景、profile 帧）出的错：留到下一次 `finish()` 一并交出（最多 100 条）。 */
  private idleErrors: string[] = [];
  readonly device: GPUDevice;

  constructor(
    private readonly real: GPUDevice,
    options: TraceOptions,
  ) {
    this.readback = options.readback ?? [];
    this.maxVertices = Math.max(
      0,
      Math.min(MAX_TRACE_VERTICES, Math.floor(options.maxVertices ?? DEFAULT_TRACE_VERTICES)),
    );
    this.addCopySrc = this.readback.length > 0;
    const queue = forwardingProxy(real.queue, {
      writeBuffer: (...args: unknown[]) => this.writeBuffer(args),
      writeTexture: (...args: unknown[]) => this.queueCopy("writeTexture", args, null),
      copyExternalImageToTexture: (...args: unknown[]) =>
        this.queueCopy("copyExternalImageToTexture", args, "external"),
      submit: (...args: unknown[]) => this.submit(args),
    });
    this.device = forwardingProxy(real, {
      queue,
      createBuffer: (...args: unknown[]) => this.createBuffer(args),
      createTexture: (...args: unknown[]) => this.createTexture(args),
      createSampler: (...args: unknown[]) =>
        this.register(call(real.createSampler as Fn, real, args) as object, (object) =>
          this.samplers.set(object, this.samplerInfo(args[0] as GPUSamplerDescriptor | undefined)),
        ),
      createShaderModule: (...args: unknown[]) =>
        this.register(call(real.createShaderModule as Fn, real, args) as object, (object) =>
          this.modules.set(object, { label: (args[0] as GPUShaderModuleDescriptor).label ?? "" }),
        ),
      createBindGroupLayout: (...args: unknown[]) =>
        this.register(call(real.createBindGroupLayout as Fn, real, args) as object, (object) =>
          this.layouts.set(object, this.layoutInfo(args[0] as GPUBindGroupLayoutDescriptor)),
        ),
      createBindGroup: (...args: unknown[]) =>
        this.register(call(real.createBindGroup as Fn, real, args) as object, (object) =>
          this.bindGroups.set(object, this.bindGroupInfo(args[0] as GPUBindGroupDescriptor)),
        ),
      createRenderPipeline: (...args: unknown[]) =>
        this.register(call(real.createRenderPipeline as Fn, real, args) as object, (object) =>
          this.pipelines.set(object, this.pipelineInfo(args[0] as GPURenderPipelineDescriptor)),
        ),
      createRenderPipelineAsync: (...args: unknown[]) =>
        (call(real.createRenderPipelineAsync as Fn, real, args) as Promise<GPURenderPipeline>).then((pipeline) =>
          this.register(pipeline, (object) =>
            this.pipelines.set(object, this.pipelineInfo(args[0] as GPURenderPipelineDescriptor)),
          ),
        ),
      createCommandEncoder: (...args: unknown[]) => this.createCommandEncoder(args),
    });
  }

  private static emptyFrame(): Frame {
    return {
      passes: [],
      copies: [],
      draws: 0,
      submits: 0,
      readbacks: [],
      errors: [],
      textures: new Set(),
      buffers: new Set(),
      samplers: new Set(),
      pipelines: new Set(),
    };
  }

  /** 帧内引用了这张纹理（记录时进 `resources`），返回它的 ID。 */
  private refTexture(info: TextureInfo | null | undefined): string {
    if (!info) return "?";
    if (this.recording) this.frame.textures.add(info);
    return info.id;
  }

  private refBuffer(info: BufferInfo | null | undefined): string {
    if (!info) return "?";
    if (this.recording) this.frame.buffers.add(info);
    return info.id;
  }

  private refSampler(info: SamplerInfo): string {
    if (this.recording) this.frame.samplers.add(info);
    return info.id;
  }

  private refPipeline(info: PipelineInfo): string {
    if (this.recording) this.frame.pipelines.add(info);
    return info.id;
  }

  private nextId(prefix: string): string {
    const n = this.counters.get(prefix) ?? 0;
    this.counters.set(prefix, n + 1);
    return `${prefix}${n}`;
  }

  /** 登记失败只记错、不影响返回的真对象。 */
  private register<T extends object>(object: T, record: (object: T) => void): T {
    this.guard(() => record(object));
    return object;
  }

  private guard(action: () => void): void {
    try {
      action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.recording) this.frame.errors.push(message);
      else if (this.idleErrors.length < 100) this.idleErrors.push(`（记录之外）${message}`);
    }
  }

  // ------------------------------------------------------------ 资源

  private createBuffer(args: unknown[]): GPUBuffer {
    const buffer = call(this.real.createBuffer as Fn, this.real, args) as GPUBuffer;
    return this.register(buffer, (object) => {
      const descriptor = args[0] as GPUBufferDescriptor;
      const info: BufferInfo = {
        id: this.nextId("b"),
        label: descriptor.label ?? "",
        size: descriptor.size,
        usage: descriptor.usage,
        object,
        shadow: null,
        tracked: true,
        mapped: [],
      };
      this.buffers.set(object, info);
      // 读回用的 MAP_READ 缓冲不进影子，也不用拦映射
      if (descriptor.usage & BUFFER_MAP_READ) return;
      patch(
        object,
        "getMappedRange",
        (original) =>
          ((...a: unknown[]) => {
            const range = call(original, object, a) as ArrayBuffer;
            info.mapped.push({ offset: (a[0] as number | undefined) ?? 0, range });
            return range;
          }) as Fn,
      );
      patch(
        object,
        "unmap",
        (original) =>
          ((...a: unknown[]) => {
            // unmap 之后给出去的 ArrayBuffer 被分离，先拷
            this.guard(() => {
              for (const { offset, range } of info.mapped) this.writeShadow(info, offset, new Uint8Array(range));
            });
            info.mapped = [];
            return call(original, object, a);
          }) as Fn,
      );
    });
  }

  private createTexture(args: unknown[]): GPUTexture {
    const descriptor = args[0] as GPUTextureDescriptor;
    const format = descriptor.format as string;
    const usage = descriptor.usage;
    // 读回：颜色附件在建的时候补 COPY_SRC（pass 结束后才能拷出来）
    const add =
      this.addCopySrc &&
      usage & TEXTURE_RENDER_ATTACHMENT &&
      !(usage & TEXTURE_COPY_SRC) &&
      !isDepthFormat(format) &&
      (descriptor.sampleCount ?? 1) === 1;
    const forwarded = add ? [{ ...descriptor, usage: usage | TEXTURE_COPY_SRC }, ...args.slice(1)] : args;
    const texture = call(this.real.createTexture as Fn, this.real, forwarded) as GPUTexture;
    return this.register(texture, (object) => {
      const info: TextureInfo = {
        id: this.nextId("t"),
        label: descriptor.label ?? "",
        size: extent(descriptor.size),
        format,
        mipLevelCount: descriptor.mipLevelCount ?? 1,
        sampleCount: descriptor.sampleCount ?? 1,
        dimension: descriptor.dimension ?? "2d",
        usage,
        actualUsage: add ? usage | TEXTURE_COPY_SRC : usage,
        object,
      };
      this.textures.set(object, info);
      patch(
        object,
        "createView",
        (original) =>
          ((...a: unknown[]) => {
            const view = call(original, object, a) as GPUTextureView;
            return this.register(view, (v) => {
              const d = (a[0] as GPUTextureViewDescriptor | undefined) ?? {};
              this.views.set(v, {
                texture: info,
                label: d.label ?? info.label,
                mip: d.baseMipLevel ?? 0,
                layer: d.baseArrayLayer ?? 0,
              });
            });
          }) as Fn,
      );
    });
  }

  /** 不经记录器建的纹理：按对象自己的属性登记（真 `GPUTexture` 有宽高、格式、用途）。 */
  private textureOf(object: object): TextureInfo {
    let info = this.textures.get(object);
    if (!info) {
      const t = object as Partial<GPUTexture>;
      info = {
        id: this.nextId("t"),
        label: t.label ?? "",
        size: [t.width ?? 0, t.height ?? 0, t.depthOrArrayLayers ?? 1],
        format: (t.format as string | undefined) ?? "?",
        mipLevelCount: t.mipLevelCount ?? 1,
        sampleCount: t.sampleCount ?? 1,
        dimension: (t.dimension as string | undefined) ?? "2d",
        usage: t.usage ?? 0,
        actualUsage: t.usage ?? 0,
        object: object as GPUTexture,
      };
      this.textures.set(object, info);
    }
    return info;
  }

  /** 视图（或直接给的纹理）→ 视图信息；不经记录器建的视图不知道属于哪张纹理。 */
  private viewOf(object: unknown): ViewInfo {
    if (!object || typeof object !== "object") return { texture: null, label: "", mip: 0, layer: 0 };
    const view = this.views.get(object);
    if (view) return view;
    if (this.textures.has(object)) {
      const texture = this.textures.get(object)!;
      return { texture, label: texture.label, mip: 0, layer: 0 };
    }
    return { texture: null, label: (object as { label?: string }).label ?? "", mip: 0, layer: 0 };
  }

  private bufferOf(object: unknown): BufferInfo | null {
    if (!object || typeof object !== "object") return null;
    let info = this.buffers.get(object);
    if (!info) {
      const b = object as Partial<GPUBuffer>;
      info = {
        id: this.nextId("b"),
        label: b.label ?? "",
        size: b.size ?? 0,
        usage: b.usage ?? 0,
        object: object as GPUBuffer,
        shadow: null,
        tracked: false,
        mapped: [],
      };
      this.buffers.set(object, info);
    }
    return info;
  }

  private samplerInfo(descriptor: GPUSamplerDescriptor | undefined): SamplerInfo {
    const { label, ...rest } = descriptor ?? {};
    return { id: this.nextId("s"), label: label ?? "", descriptor: { ...rest } };
  }

  private layoutInfo(descriptor: GPUBindGroupLayoutDescriptor): LayoutInfo {
    const dynamic = [...descriptor.entries]
      .filter((entry) => entry.buffer?.hasDynamicOffset)
      .map((entry) => entry.binding)
      .sort((a, b) => a - b);
    return { dynamic };
  }

  private bindGroupInfo(descriptor: GPUBindGroupDescriptor): BindGroupInfo {
    const entries: EntryInfo[] = [];
    for (const entry of descriptor.entries) {
      const resource = entry.resource as unknown;
      const binding = entry.binding;
      if (resource && typeof resource === "object") {
        if (this.samplers.has(resource)) {
          entries.push({ binding, kind: "sampler", sampler: this.samplers.get(resource)! });
          continue;
        }
        if (this.views.has(resource) || this.textures.has(resource)) {
          entries.push({ binding, kind: "texture", view: this.viewOf(resource) });
          continue;
        }
        if (this.buffers.has(resource)) {
          entries.push({ binding, kind: "buffer", buffer: this.buffers.get(resource)!, offset: 0, size: undefined });
          continue;
        }
        const bufferBinding = resource as Partial<GPUBufferBinding>;
        if (bufferBinding.buffer) {
          entries.push({
            binding,
            kind: "buffer",
            buffer: this.bufferOf(bufferBinding.buffer)!,
            offset: bufferBinding.offset ?? 0,
            size: bufferBinding.size,
          });
          continue;
        }
      }
      entries.push({ binding, kind: "other", label: (resource as { label?: string } | null)?.label ?? "" });
    }
    return {
      id: this.nextId("g"),
      label: descriptor.label ?? "",
      layout: this.layouts.get(descriptor.layout as object) ?? null,
      entries,
    };
  }

  private moduleLabel(module: unknown): string {
    if (!module || typeof module !== "object") return "";
    return this.modules.get(module)?.label ?? (module as { label?: string }).label ?? "";
  }

  private pipelineInfo(descriptor: GPURenderPipelineDescriptor): PipelineInfo {
    const vertex = [...(descriptor.vertex.buffers ?? [])].map((layout) =>
      layout
        ? {
            arrayStride: layout.arrayStride,
            stepMode: layout.stepMode ?? "vertex",
            attributes: [...layout.attributes].map((a) => ({
              shaderLocation: a.shaderLocation,
              format: a.format as string,
              offset: a.offset,
            })),
          }
        : null,
    );
    const component = (c: GPUBlendComponent | undefined): GPUBlendComponent => ({
      operation: c?.operation ?? "add",
      srcFactor: c?.srcFactor ?? "one",
      dstFactor: c?.dstFactor ?? "zero",
    });
    const targets = [...(descriptor.fragment?.targets ?? [])].map((target) =>
      target
        ? {
            format: target.format as string,
            ...(target.blend
              ? { blend: { color: component(target.blend.color), alpha: component(target.blend.alpha) } }
              : {}),
            writeMask: target.writeMask ?? 0xf,
          }
        : null,
    );
    const depth = descriptor.depthStencil;
    const shaders = [
      {
        stage: "vertex",
        module: this.moduleLabel(descriptor.vertex.module),
        entryPoint: descriptor.vertex.entryPoint ?? "",
      },
      ...(descriptor.fragment
        ? [
            {
              stage: "fragment",
              module: this.moduleLabel(descriptor.fragment.module),
              entryPoint: descriptor.fragment.entryPoint ?? "",
            },
          ]
        : []),
    ];
    return {
      id: this.nextId("p"),
      json: {
        label: descriptor.label ?? "",
        topology: descriptor.primitive?.topology ?? "triangle-list",
        cullMode: descriptor.primitive?.cullMode ?? "none",
        frontFace: descriptor.primitive?.frontFace ?? "ccw",
        vertex,
        targets,
        ...(depth
          ? {
              depth: {
                format: depth.format,
                depthCompare: depth.depthCompare ?? null,
                depthWriteEnabled: depth.depthWriteEnabled ?? null,
                depthBias: depth.depthBias ?? 0,
              },
            }
          : {}),
        shaders,
      },
    };
  }

  // ------------------------------------------------------------ 队列

  private writeShadow(info: BufferInfo, offset: number, bytes: Uint8Array): void {
    if (!info.tracked || info.usage & BUFFER_MAP_READ) return;
    info.shadow ??= new Uint8Array(info.size);
    const n = Math.max(0, Math.min(bytes.byteLength, info.size - offset));
    if (n > 0) info.shadow.set(bytes.subarray(0, n), offset);
  }

  private writeBuffer(args: unknown[]): unknown {
    const result = call(this.real.queue.writeBuffer as Fn, this.real.queue, args);
    this.guard(() => {
      const info = this.bufferOf(args[0]);
      if (info)
        this.writeShadow(
          info,
          args[1] as number,
          sourceBytes(args[2], args[3] as number | undefined, args[4] as number | undefined),
        );
    });
    return result;
  }

  /** 队列上的纹理写入：只在帧内进拷贝表（不读内容）。 */
  private queueCopy(kind: string, args: unknown[], source: string | null): unknown {
    const queue = this.real.queue;
    const result = call(queue[kind as keyof GPUQueue] as Fn, queue, args);
    if (this.recording)
      this.guard(() => {
        const destination = (kind === "writeTexture" ? args[0] : args[1]) as GPUTexelCopyTextureInfo;
        const size = (kind === "writeTexture" ? args[3] : args[2]) as GPUExtent3D;
        this.frame.copies.push({
          order: this.frame.passes.length,
          kind: `queue.${kind}`,
          src: source ?? "data",
          dst: this.refTexture(this.textureOf(destination.texture)),
          size: extent(size),
        });
      });
    return result;
  }

  private submit(args: unknown[]): unknown {
    this.guard(() => {
      const index = this.recording ? this.frame.submits++ : null;
      for (const commandBuffer of (args[0] as Iterable<object>) ?? []) {
        const encoder = this.commandBuffers.get(commandBuffer);
        if (!encoder || encoder.submitted) continue;
        encoder.submitted = true;
        for (const event of encoder.events) {
          if (event.kind === "pass") {
            event.pass.json.submit = index;
            for (const draw of event.pass.draws) this.resolveDraw(draw);
          } else if (event.kind === "copy-buffer") {
            if (!event.src?.shadow || !event.dst) continue;
            const bytes = event.src.shadow.slice(event.srcOffset, event.srcOffset + event.size);
            this.writeShadow(event.dst, event.dstOffset, bytes);
          } else if (event.buffer?.shadow) {
            const end = event.size === undefined ? event.buffer.size : event.offset + event.size;
            event.buffer.shadow.fill(0, event.offset, end);
          }
        }
      }
    });
    return call(this.real.queue.submit as Fn, this.real.queue, args);
  }

  // ------------------------------------------------------------ 编码

  private createCommandEncoder(args: unknown[]): GPUCommandEncoder {
    const encoder = call(this.real.createCommandEncoder as Fn, this.real, args) as GPUCommandEncoder;
    return this.register(encoder, (object) => {
      const original = (name: string) => (object as unknown as Record<string, Fn>)[name];
      const copyTextureToBuffer = original("copyTextureToBuffer");
      const record: EncoderRecord = {
        label: (args[0] as GPUCommandEncoderDescriptor | undefined)?.label ?? "",
        events: [],
        submitted: false,
        copyTextureToBuffer: (...a) => {
          call(copyTextureToBuffer, object, a);
        },
      };
      patch(
        object,
        "beginRenderPass",
        (begin) =>
          ((...a: unknown[]) => {
            const pass = call(begin, object, a) as GPURenderPassEncoder;
            if (this.recording) this.guard(() => this.beginPass(record, pass, a[0] as GPURenderPassDescriptor));
            return pass;
          }) as Fn,
      );
      patch(
        object,
        "copyBufferToBuffer",
        (copy) =>
          ((...a: unknown[]) => {
            const result = call(copy, object, a);
            this.guard(() => {
              // 新写法 (src, dst, size?) 与旧写法 (src, srcOffset, dst, dstOffset, size)
              const short = a.length <= 3;
              const src = this.bufferOf(a[0]);
              const dst = this.bufferOf(short ? a[1] : a[2]);
              const srcOffset = short ? 0 : (a[1] as number);
              const dstOffset = short ? 0 : (a[3] as number);
              const size = (short ? a[2] : a[4]) as number | undefined;
              const length = size ?? Math.max(0, (src?.size ?? 0) - srcOffset);
              record.events.push({ kind: "copy-buffer", src, srcOffset, dst, dstOffset, size: length });
              this.frameCopy("copyBufferToBuffer", this.refBuffer(src), this.refBuffer(dst), [length, 1, 1]);
            });
            return result;
          }) as Fn,
      );
      patch(
        object,
        "clearBuffer",
        (clear) =>
          ((...a: unknown[]) => {
            const result = call(clear, object, a);
            this.guard(() => {
              const buffer = this.bufferOf(a[0]);
              record.events.push({
                kind: "clear-buffer",
                buffer,
                offset: (a[1] as number | undefined) ?? 0,
                size: a[2] as number | undefined,
              });
              const size =
                (a[2] as number | undefined) ?? Math.max(0, (buffer?.size ?? 0) - ((a[1] as number | undefined) ?? 0));
              this.frameCopy("clearBuffer", "", this.refBuffer(buffer), [size, 1, 1]);
            });
            return result;
          }) as Fn,
      );
      for (const name of ["copyBufferToTexture", "copyTextureToBuffer", "copyTextureToTexture"] as const) {
        patch(
          object,
          name,
          (copy) =>
            ((...a: unknown[]) => {
              const result = call(copy, object, a);
              this.guard(() => {
                const side = (value: unknown, isTexture: boolean) =>
                  isTexture
                    ? this.refTexture(this.textureOf((value as GPUTexelCopyTextureInfo).texture))
                    : this.refBuffer(this.bufferOf((value as GPUTexelCopyBufferInfo).buffer));
                const src = side(a[0], name !== "copyBufferToTexture");
                const dst = side(a[1], name !== "copyTextureToBuffer");
                this.frameCopy(name, src, dst, extent(a[2] as GPUExtent3D));
              });
              return result;
            }) as Fn,
        );
      }
      patch(
        object,
        "finish",
        (finish) =>
          ((...a: unknown[]) => {
            const commandBuffer = call(finish, object, a) as GPUCommandBuffer;
            this.register(commandBuffer, (cb) => this.commandBuffers.set(cb, record));
            return commandBuffer;
          }) as Fn,
      );
    });
  }

  private frameCopy(kind: string, src: string, dst: string, size: number[]): void {
    if (this.recording) this.frame.copies.push({ order: this.frame.passes.length, kind, src, dst, size });
  }

  private attachmentJson(view: ViewInfo, rest: { loadOp: string; storeOp: string; clearValue?: number[] }) {
    return {
      texture: this.refTexture(view.texture),
      label: view.texture?.label ?? view.label,
      mip: view.mip,
      layer: view.layer,
      ...rest,
    };
  }

  private beginPass(encoder: EncoderRecord, pass: GPURenderPassEncoder, descriptor: GPURenderPassDescriptor): void {
    const colors = [...(descriptor.colorAttachments ?? [])];
    let first: ViewInfo | null = null;
    const colorAttachments = colors.map((attachment) => {
      if (!attachment) return null;
      const view = this.viewOf(attachment.view);
      first ??= view;
      const loadOp = attachment.loadOp as string;
      return this.attachmentJson(view, {
        loadOp,
        storeOp: attachment.storeOp as string,
        ...(loadOp === "clear" ? { clearValue: color(attachment.clearValue) } : {}),
      });
    });
    const depth = descriptor.depthStencilAttachment;
    const depthView = depth ? this.viewOf(depth.view) : null;
    const sized = first ?? depthView;
    const size: [number, number] | null = sized?.texture
      ? [Math.max(1, sized.texture.size[0] >> sized.mip), Math.max(1, sized.texture.size[1] >> sized.mip)]
      : null;
    const record: PassRecord = {
      json: {
        index: this.frame.passes.length,
        label: descriptor.label ?? "",
        encoder: encoder.label,
        submit: null,
        colorAttachments,
        ...(depth && depthView
          ? {
              depthAttachment: {
                texture: this.refTexture(depthView.texture),
                label: depthView.texture?.label ?? depthView.label,
                mip: depthView.mip,
                layer: depthView.layer,
                ...(depth.depthLoadOp ? { depthLoadOp: depth.depthLoadOp } : {}),
                ...(depth.depthStoreOp ? { depthStoreOp: depth.depthStoreOp } : {}),
                ...(depth.depthLoadOp === "clear" ? { depthClearValue: depth.depthClearValue ?? 0 } : {}),
                ...(depth.depthReadOnly ? { depthReadOnly: true } : {}),
              },
            }
          : {}),
        draws: [],
      },
      draws: [],
      size,
      attachment: first,
    };
    this.frame.passes.push(record);
    encoder.events.push({ kind: "pass", pass: record });
    this.patchPass(encoder, pass, record);
  }

  private patchPass(encoder: EncoderRecord, pass: GPURenderPassEncoder, record: PassRecord): void {
    const state = {
      pipeline: null as PipelineInfo | null,
      groups: new Map<number, { group: BindGroupInfo | null; offsets: number[] }>(),
      vertex: new Map<number, BufferRange>(),
      index: null as (BufferRange & { format: GPUIndexFormat }) | null,
      viewport: null as number[] | null,
      scissor: null as number[] | null,
      blend: null as number[] | null,
      stencil: null as number | null,
    };
    const hook = (name: string, after: (args: unknown[]) => void) =>
      patch(
        pass,
        name,
        (original) =>
          ((...a: unknown[]) => {
            const result = call(original, pass, a);
            this.guard(() => after(a));
            return result;
          }) as Fn,
      );
    const range = (buffer: unknown, offset: unknown, size: unknown): BufferRange | null => {
      const info = this.bufferOf(buffer);
      if (!info) return null;
      const start = (offset as number | undefined) ?? 0;
      return { buffer: info, offset: start, size: (size as number | undefined) ?? Math.max(0, info.size - start) };
    };
    hook("setPipeline", ([pipeline]) => {
      state.pipeline = this.pipelines.get(pipeline as object) ?? null;
    });
    hook("setBindGroup", ([index, group, offsets, start, length]) => {
      let list: number[] = [];
      if (offsets) {
        const all = Array.from(offsets as Iterable<number>);
        list = start === undefined ? all : all.slice(start as number, (start as number) + (length as number));
      }
      state.groups.set(index as number, {
        group: group ? (this.bindGroups.get(group as object) ?? null) : null,
        offsets: list,
      });
    });
    hook("setVertexBuffer", ([slot, buffer, offset, size]) => {
      const bound = buffer ? range(buffer, offset, size) : null;
      if (bound) state.vertex.set(slot as number, bound);
      else state.vertex.delete(slot as number);
    });
    hook("setIndexBuffer", ([buffer, format, offset, size]) => {
      const bound = range(buffer, offset, size);
      state.index = bound ? { ...bound, format: format as GPUIndexFormat } : null;
    });
    hook("setViewport", (a) => {
      state.viewport = (a as number[]).slice(0, 6);
    });
    hook("setScissorRect", (a) => {
      state.scissor = (a as number[]).slice(0, 4);
    });
    hook("setBlendConstant", ([value]) => {
      state.blend = color(value as GPUColor);
    });
    hook("setStencilReference", ([value]) => {
      state.stencil = value as number;
    });
    const draw = (kind: TraceDraw["call"]["kind"], callInfo: Omit<TraceDraw["call"], "kind">) => {
      const bindings: TraceBinding[] = [];
      const uniforms: DrawRecord["uniforms"] = [];
      const dynamicOffsets: Record<number, number[]> = {};
      for (const [group, { group: info, offsets }] of [...state.groups].sort((x, y) => x[0] - y[0])) {
        if (offsets.length) dynamicOffsets[group] = offsets;
        if (!info) continue;
        const dynamic = info.layout?.dynamic ?? [];
        for (const entry of [...info.entries].sort((x, y) => x.binding - y.binding)) {
          if (entry.kind === "buffer") {
            const k = dynamic.indexOf(entry.binding);
            const offset = entry.offset + (k >= 0 ? (offsets[k] ?? 0) : 0);
            const size = entry.size ?? Math.max(0, entry.buffer.size - entry.offset);
            bindings.push({
              group,
              binding: entry.binding,
              kind: "buffer",
              id: this.refBuffer(entry.buffer),
              label: entry.buffer.label,
              offset,
              size,
            });
            if (entry.buffer.usage & BUFFER_UNIFORM)
              uniforms.push({ group, binding: entry.binding, buffer: entry.buffer, offset, size });
          } else if (entry.kind === "texture") {
            bindings.push({
              group,
              binding: entry.binding,
              kind: "texture",
              id: this.refTexture(entry.view.texture),
              label: entry.view.texture?.label ?? entry.view.label,
              view: { mip: entry.view.mip, layer: entry.view.layer },
            });
          } else if (entry.kind === "sampler") {
            bindings.push({
              group,
              binding: entry.binding,
              kind: "sampler",
              id: this.refSampler(entry.sampler),
              label: entry.sampler.label,
            });
          } else bindings.push({ group, binding: entry.binding, kind: "other", id: "?", label: entry.label });
        }
      }
      const size = record.size;
      const json: TraceDraw = {
        index: this.frame.draws++,
        pipeline: state.pipeline ? this.refPipeline(state.pipeline) : null,
        ...(state.viewport ? { viewport: state.viewport } : size ? { viewport: [0, 0, size[0], size[1], 0, 1] } : {}),
        ...(state.scissor ? { scissor: state.scissor } : size ? { scissor: [0, 0, size[0], size[1]] } : {}),
        ...(state.blend ? { blendConstant: state.blend } : {}),
        ...(state.stencil !== null ? { stencilReference: state.stencil } : {}),
        call: { kind, ...callInfo },
        bindings,
        ...(Object.keys(dynamicOffsets).length ? { dynamicOffsets } : {}),
        ...(state.vertex.size
          ? {
              vertexBuffers: [...state.vertex]
                .sort((x, y) => x[0] - y[0])
                .map(([slot, b]) => ({
                  slot,
                  id: this.refBuffer(b.buffer),
                  label: b.buffer.label,
                  offset: b.offset,
                  size: b.size,
                })),
            }
          : {}),
        ...(state.index
          ? {
              indexBuffer: {
                id: this.refBuffer(state.index.buffer),
                label: state.index.buffer.label,
                format: state.index.format,
                offset: state.index.offset,
                size: state.index.size,
              },
            }
          : {}),
      };
      const drawRecord: DrawRecord = {
        json,
        pipeline: state.pipeline,
        uniforms,
        vertex: new Map(state.vertex),
        index: state.index && kind === "drawIndexed" ? state.index : null,
        resolved: false,
      };
      record.draws.push(drawRecord);
      record.json.draws.push(json);
    };
    hook("draw", ([count, instances, first, firstInstance]) =>
      draw("draw", {
        count: count as number,
        instances: (instances as number | undefined) ?? 1,
        first: (first as number | undefined) ?? 0,
        firstInstance: (firstInstance as number | undefined) ?? 0,
      }),
    );
    hook("drawIndexed", ([count, instances, first, baseVertex, firstInstance]) =>
      draw("drawIndexed", {
        count: count as number,
        instances: (instances as number | undefined) ?? 1,
        first: (first as number | undefined) ?? 0,
        baseVertex: (baseVertex as number | undefined) ?? 0,
        firstInstance: (firstInstance as number | undefined) ?? 0,
      }),
    );
    hook("drawIndirect", () => draw("drawIndirect", { count: 0, instances: 0, first: 0, firstInstance: 0 }));
    hook("drawIndexedIndirect", () =>
      draw("drawIndexedIndirect", { count: 0, instances: 0, first: 0, baseVertex: 0, firstInstance: 0 }),
    );
    hook("end", () => this.scheduleReadback(encoder, record));
  }

  /** pass 结束后：选中了就在同一个编码器里把颜色附件 0 拷进读回缓冲。 */
  private scheduleReadback(encoder: EncoderRecord, record: PassRecord): void {
    const { json } = record;
    const chosen = this.readback.some((key) =>
      typeof key === "number"
        ? key === json.index
        : key !== "" &&
          (json.label.includes(key) || json.colorAttachments.some((attachment) => attachment?.label.includes(key))),
    );
    if (!chosen) return;
    const view = record.attachment;
    const texture = view?.texture;
    if (!view || !texture) {
      json.readbackError = "没有颜色附件，或附件的纹理不是经记录器建的";
      return;
    }
    const format = READBACK_FORMATS[texture.format];
    if (!format) {
      json.readbackError = `格式 ${texture.format} 不读回（只读 rgba8 / bgra8 / rgba16float / rgba32float）`;
      return;
    }
    if (!(texture.actualUsage & TEXTURE_COPY_SRC)) {
      json.readbackError = `纹理 ${texture.id}（${texture.label}）没有 COPY_SRC`;
      return;
    }
    if (texture.dimension !== "2d" || texture.sampleCount !== 1) {
      json.readbackError = `纹理 ${texture.id} 是 ${texture.dimension}、${texture.sampleCount} 采样，只读回单采样的 2d 纹理`;
      return;
    }
    const width = Math.max(1, texture.size[0] >> view.mip);
    const height = Math.max(1, texture.size[1] >> view.mip);
    const bytesPerRow = Math.ceil((width * format.texel) / 256) * 256;
    const buffer = call(this.real.createBuffer as Fn, this.real, [
      {
        label: `trace readback pass ${json.index}`,
        size: bytesPerRow * height,
        usage: BUFFER_COPY_DST | BUFFER_MAP_READ,
      },
    ]) as GPUBuffer;
    encoder.copyTextureToBuffer(
      { texture: texture.object, mipLevel: view.mip, origin: { x: 0, y: 0, z: view.layer } },
      { buffer, bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    this.frame.readbacks.push({ pass: record, texture, buffer, width, height, bytesPerRow, encoder });
  }

  // ------------------------------------------------------------ 提交时取值

  /**
   * 绑定区间在影子里的字节（视图，不拷贝：提交时当场解码成数组，之后影子再变也不影响）。没写过的缓冲是全 0（WebGPU 建缓冲时清零），
   * 区间超出缓冲的部分截掉（读到时是 NaN）；不经记录器建的缓冲没有影子，null。
   */
  private bytesOf(range: BufferRange): Uint8Array | null {
    const info = range.buffer;
    if (!info.tracked) return null;
    info.shadow ??= new Uint8Array(info.size);
    const start = Math.min(range.offset, info.shadow.byteLength);
    return info.shadow.subarray(start, Math.min(info.shadow.byteLength, range.offset + range.size));
  }

  private resolveDraw(draw: DrawRecord): void {
    if (draw.resolved) return;
    draw.resolved = true;
    this.guard(() => {
      const json = draw.json;
      const reflected: { group: number; binding: number; values: Record<string, number | number[]> }[] = [];
      const raw: NonNullable<TraceDraw["rawUniforms"]> = [];
      for (const binding of draw.uniforms) {
        const bytes = this.bytesOf(binding);
        if (!bytes) continue;
        const entries = uniformReflections.get(binding.buffer.object);
        if (entries)
          reflected.push({ group: binding.group, binding: binding.binding, values: decodeUniforms(entries, bytes) });
        else {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          raw.push({
            group: binding.group,
            binding: binding.binding,
            f32: Array.from({ length: bytes.byteLength >> 2 }, (_, i) => view.getFloat32(i * 4, true)),
          });
        }
      }
      if (reflected.length === 1) json.uniforms = reflected[0].values;
      else if (reflected.length > 1) {
        // 一个 draw 绑了几块登记过的 uniform（场景里没有）：名字前加「组.绑定.」
        json.uniforms = {};
        for (const { group, binding, values } of reflected)
          for (const [name, value] of Object.entries(values)) json.uniforms[`${group}.${binding}.${name}`] = value;
      }
      if (raw.length) json.rawUniforms = raw;
      this.resolveGeometry(draw);
    });
  }

  private resolveGeometry(draw: DrawRecord): void {
    const json = draw.json;
    const max = this.maxVertices;
    const { kind } = json.call;
    if (kind !== "draw" && kind !== "drawIndexed") return;
    let rows: number[];
    if (kind === "drawIndexed") {
      const index = draw.index;
      if (!index) return;
      const bytes = this.bytesOf(index);
      if (!bytes) return;
      const width = index.format === "uint32" ? 4 : 2;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const indices: number[] = [];
      for (let i = 0; i < Math.min(json.call.count, max); i++) {
        const at = (json.call.first + i) * width;
        indices.push(
          at + width > bytes.byteLength ? NaN : width === 4 ? view.getUint32(at, true) : view.getUint16(at, true),
        );
      }
      json.indices = indices;
      rows = indices.map((value) => value + (json.call.baseVertex ?? 0));
    } else {
      rows = Array.from({ length: Math.min(json.call.count, max) }, (_, i) => json.call.first + i);
    }
    const instances = Array.from({ length: Math.min(json.call.instances, max) }, (_, i) => json.call.firstInstance + i);
    const layouts = draw.pipeline?.json.vertex ?? [];
    const vertices: Record<string, number[][]> = {};
    layouts.forEach((layout, slot) => {
      const bound = draw.vertex.get(slot);
      if (!layout || !bound) return;
      const bytes = this.bytesOf(bound);
      if (!bytes) return;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const perInstance = layout.stepMode === "instance";
      for (const attribute of layout.attributes) {
        const key = `loc${attribute.shaderLocation}:${attribute.format}${perInstance ? "@instance" : ""}`;
        const list = (perInstance ? instances : rows).map(
          (row) => readVertexAttribute(view, row * layout.arrayStride + attribute.offset, attribute.format) ?? [],
        );
        vertices[key] = list;
      }
    });
    if (Object.keys(vertices).length) json.vertices = vertices;
  }

  // ------------------------------------------------------------ 帧

  startFrame(): void {
    this.frame = Tracer.emptyFrame();
    this.recording = true;
  }

  async finish(): Promise<{ trace: DrawTrace; readbacks: TraceReadback[] }> {
    this.recording = false;
    const frame = this.frame;
    this.frame = Tracer.emptyFrame();
    frame.errors.unshift(...this.takeIdleErrors());
    const readbacks: TraceReadback[] = [];
    for (const pending of frame.readbacks) {
      const { pass, texture, buffer, width, height, bytesPerRow } = pending;
      try {
        if (!pending.encoder.submitted) {
          pass.json.readbackError = "读回所在的命令缓冲到 finish() 还没提交";
          continue;
        }
        await buffer.mapAsync(MAP_MODE_READ);
        const raw = new Uint8Array(buffer.getMappedRange());
        readbacks.push({
          pass: pass.json.index,
          label: pass.json.label,
          texture: texture.id,
          width,
          height,
          format: texture.format,
          ...convertReadback(raw, texture.format, width, height, bytesPerRow),
        });
        buffer.unmap();
      } catch (error) {
        pass.json.readbackError = `读回失败：${error instanceof Error ? error.message : String(error)}`;
      } finally {
        buffer.destroy();
      }
    }
    return { trace: this.serialize(frame), readbacks };
  }

  private serialize(frame: Frame): DrawTrace {
    const byId = <I extends { id: string }, T>(set: Set<I>, json: (info: I) => T): Record<string, T> =>
      Object.fromEntries(
        [...set].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })).map((info) => [info.id, json(info)]),
      );
    return {
      version: 1,
      resources: {
        textures: byId(frame.textures, (info) => ({
          label: info.label,
          size: [...info.size],
          format: info.format,
          mipLevelCount: info.mipLevelCount,
          usage: info.usage,
          ...(info.dimension !== "2d" ? { dimension: info.dimension } : {}),
          ...(info.sampleCount !== 1 ? { sampleCount: info.sampleCount } : {}),
        })),
        buffers: byId(frame.buffers, (info) => ({ label: info.label, size: info.size, usage: info.usage })),
        samplers: byId(frame.samplers, (info) => ({ label: info.label, ...info.descriptor })),
        pipelines: byId(frame.pipelines, (info) => info.json),
      },
      passes: frame.passes.map((pass) => pass.json),
      copies: frame.copies,
      ...(frame.errors.length ? { errors: frame.errors } : {}),
    };
  }

  /** 交出记录之外攒下的错（`finish()` 时并进轨迹的 `errors`，排在帧内的前面）。 */
  private takeIdleErrors(): string[] {
    const errors = this.idleErrors;
    this.idleErrors = [];
    return errors;
  }
}

/** 读回缓冲（带行填充）→ 紧排的 RGBA：8 位格式给字节（bgra 换成 rgba），浮点格式给单精度。 */
export function convertReadback(
  raw: Uint8Array,
  format: string,
  width: number,
  height: number,
  bytesPerRow: number,
): { kind: "rgba8" | "f32"; data: Uint8Array | Float32Array } {
  const spec = READBACK_FORMATS[format];
  if (!spec) throw new Error(`格式 ${format} 不读回`);
  const rowBytes = width * spec.texel;
  if (spec.kind === "rgba8") {
    const out = new Uint8Array(width * height * 4);
    const bgra = format.startsWith("bgra");
    for (let y = 0; y < height; y++) {
      const row = raw.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes);
      if (!bgra) out.set(row, y * rowBytes);
      else
        for (let x = 0; x < width; x++) {
          const i = x * 4;
          const o = y * rowBytes + i;
          out[o] = row[i + 2];
          out[o + 1] = row[i + 1];
          out[o + 2] = row[i];
          out[o + 3] = row[i + 3];
        }
    }
    return { kind: "rgba8", data: out };
  }
  const out = new Float32Array(width * height * 4);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const table = spec.texel === 8 ? halfTable() : null;
  for (let y = 0; y < height; y++)
    for (let i = 0; i < width * 4; i++) {
      const at = y * bytesPerRow + i * (spec.texel / 4);
      out[y * width * 4 + i] = table ? table[view.getUint16(at, true)] : view.getFloat32(at, true);
    }
  return { kind: "f32", data: out };
}

let halves: Float32Array | null = null;
/** 全部 65536 个半精度值的查表（4K 的 HDR 目标有三千多万个分量）。 */
function halfTable(): Float32Array {
  if (!halves) {
    halves = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) halves[i] = halfToFloat(i);
  }
  return halves;
}

/** 包设备，记录这个设备上建的资源与编码的 pass / draw（见文件头）。 */
export function createDrawTracer(device: GPUDevice, options: TraceOptions = {}): DrawTracer {
  const tracer = new Tracer(device, options);
  return {
    device: tracer.device,
    startFrame: () => tracer.startFrame(),
    finish: () => tracer.finish(),
  };
}
