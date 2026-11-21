/**
 * `layerimage` 发射器候选表的 GPU 半边（P4j 步骤 2b，`phase-4j-layerimage.md` 点 4、`rea-p4j-layerimage.md` 2.1–2.3）。
 *
 * WPE 在发射调用里同步做「降采样 → 拷进 staging → `Map` 读回」；WebGPU 读回只能异步，所以我们把「画面」和「状态机」拆开
 * （状态机在 `particles/layerImage.ts`，纯 TS）：
 * - 每帧编码的末尾（全部图层画完之后），对需要快照的记录用 WPE 原件 `downsample_quarter`（`WRITEALPHA = 1`，有 `mask` 再加
 *   `OPACITYMASK = 1`，`compile/emitterImages.ts`）把被依赖图层的独占合成 RT 画到 `w4 × h4` 的 `rgba8unorm`，再 `copyTextureToBuffer`
 *   进可读缓冲；这正是「本帧末的合成 RT」，也就是下一帧更新阶段 WPE 降采样时读到的内容。
 * - 提交之后（`afterSubmit`）对本帧拷过的缓冲 `mapAsync`，读完去掉行尾填充（`bytesPerRow` 要 256 对齐），存成这条记录「第 N 帧末」的
 *   快照。状态机的状态 0 调用「锁定」其中一份（`lock`）：上一帧末拍过就锁它（已读回或还在读回），否则锁「本帧末」那份——只出在加载后的
 *   第一帧（预热在加载时就过了门，WPE 的第一帧更新读的是加载那一帧画出的内容，我们没有那一帧）。
 *
 * 需要快照的记录（`needsSnapshot`）：门已经过（`started`）且状态还没到 2 的；带 `0x20000` 的（过 1 秒要重建，重建的状态 0 要读到上一帧末）；
 * 本帧有句柄锁了「本帧末」的。`started` 之前不拍：门在更新阶段、早于本帧编码，所以第一个发射帧的末尾就开始拍，下一个发射帧的状态 0
 * 正好锁到它；从没过过门的记录（没有一个发射帧）不浪费读回。
 *
 * 缓冲与目标按记录复用：降采样目标与 bind group 按（来源 RT、尺寸、变体）缓存，来源 RT 换了（`resize`、尺寸变了）重建；读回缓冲按字节数
 * 池化，读回完成（已 `unmap`）才还池，所以在途的缓冲不会被下一帧的拷贝覆盖。
 *
 * 与 WPE 的有意不同：状态 1 在锁定的快照读回之前返回旧表（WPE 阻塞等 GPU），产品里表晚到就晚几帧开始发射；探针的确定性回放在每帧
 * 提交之后 `await settled()`，同一帧里「0 → 1 → 2」和 WPE 一样成立。
 */
import type { ScenePass } from "../compile/bundle";
import type { SceneEmitterImagePasses } from "../compile/emitterImages";
import type { SceneParticle } from "../compile/particles";
import {
  emitterImageSize,
  EmitterImageRecords,
  type EmitterImageBinding,
  type EmitterImageHandle,
  type EmitterImageRecord,
  type EmitterImageSnapshot,
  type EmitterImageView,
} from "../particles/layerImage";
import { fullscreenTriangle } from "./layout";
import type { GpuProgram } from "./programs";
import { screenBuiltins, textureBuiltins, UniformBlock, type UniformEntry } from "./uniforms";

/** `copyTextureToBuffer` 的 `bytesPerRow` 对齐。 */
export const COPY_ROW_ALIGNMENT = 256;

/** 读回缓冲每行的字节数：`w4 · 4` 向上取 256 的倍数。 */
export function paddedBytesPerRow(w4: number): number {
  return Math.ceil((w4 * 4) / COPY_ROW_ALIGNMENT) * COPY_ROW_ALIGNMENT;
}

/** 去掉行尾填充：`raw` 是 `h4` 行、每行 `bytesPerRow` 字节，只留每行前 `w4 · 4` 字节，紧凑成行优先的 `w4 × h4 × 4`。 */
export function compactRows(raw: Uint8Array, w4: number, h4: number, bytesPerRow: number): Uint8Array {
  const rowBytes = w4 * 4;
  const out = new Uint8Array(rowBytes * h4);
  for (let row = 0; row < h4; row++)
    out.set(raw.subarray(row * bytesPerRow, row * bytesPerRow + rowBytes), row * rowBytes);
  return out;
}

/** 这条记录本帧末要不要拍快照（见文件头）。 */
export function needsSnapshot(input: {
  started: boolean;
  state: 0 | 1 | 2;
  /** 带 `0x20000` 的发射器绑了这条记录。 */
  timed: boolean;
  /** 本帧有句柄锁了「本帧末」。 */
  wanted: boolean;
}): boolean {
  return input.wanted || (input.started && (input.state < 2 || input.timed));
}

/** 一份快照（某一帧末）：读回完成前 `snapshot` 为 null。 */
export interface SnapshotEntry {
  frame: number;
  snapshot: EmitterImageSnapshot | null;
}

/**
 * 一条记录的快照台账与「锁定」规则（纯逻辑，单测）：`latest` 是最近一次拍的（或已安排要拍的）；`lock(frame)` 在更新阶段（早于本帧编码）调：
 * 上一帧末（`frame − 1`）拍过就锁它，否则锁本帧末的那份并让本帧编码一定拍（`takeWanted`）。
 */
export class SnapshotLedger {
  latest: SnapshotEntry | null = null;
  private wanted: SnapshotEntry | null = null;

  lock(frame: number): EmitterImageHandle {
    let entry: SnapshotEntry;
    if (this.latest && this.latest.frame === frame - 1) entry = this.latest;
    else if (this.wanted && this.wanted.frame === frame) entry = this.wanted;
    else this.wanted = entry = { frame, snapshot: null };
    return { snapshot: () => entry.snapshot };
  }

  /** 本帧编码前：有人锁了本帧末的那份就返回它的条目（不清，`record` 之后才落进 `latest`）。 */
  wantedAt(frame: number): SnapshotEntry | null {
    return this.wanted && this.wanted.frame === frame ? this.wanted : null;
  }

  /** 本帧编码时拍了：记为最近一份。 */
  record(entry: SnapshotEntry): void {
    this.latest = entry;
    if (this.wanted === entry) this.wanted = null;
  }
}

/** 被依赖图层的独占合成 RT（`GpuScene.layerTargets` 里的那张）。 */
export interface EmitterImageSourceTarget {
  width: number;
  height: number;
  texture: GPUTexture;
  view: GPUTextureView;
  /** 同这个图层采样自己合成 RT 的规则（`compositeSampling`）。 */
  sampler: GPUSampler;
}

/** `mask` 纹理的 GPU 视图与尺寸。 */
export interface EmitterImageMaskTexture {
  view: GPUTextureView;
  sampler: GPUSampler;
  width: number;
  height: number;
}

export interface GpuEmitterImagesInput {
  device: GPUDevice;
  passes: SceneEmitterImagePasses | undefined;
  programs: ReadonlyMap<number, GpuProgram>;
  pipelineFor(program: GpuProgram, blending: string | null, format: GPUTextureFormat): Promise<GPURenderPipeline>;
  /** 按图层 id（scene.json 的对象 id）找被依赖图层的独占合成 RT；不是图像层或没有独占 RT 时为 null。 */
  layerSource(id: number): EmitterImageSourceTarget | null;
  /** `mask` 纹理（`bundle.textures` 下标）的 GPU 视图；没上传时为 null。 */
  maskTexture(index: number): EmitterImageMaskTexture | null;
}

interface Variant {
  pass: ScenePass;
  program: GpuProgram;
  pipeline: GPURenderPipeline;
  vertexBuffer: GPUBuffer;
}

/** 一条记录的降采样目标与 bind group：按（来源 RT、变体、尺寸）缓存。 */
interface Slot {
  source: GPUTexture;
  variant: Variant;
  w4: number;
  h4: number;
  texture: GPUTexture;
  view: GPUTextureView;
  bindGroup: GPUBindGroup;
  uniformBuffer: GPUBuffer | null;
}

interface GpuRecord {
  binding: EmitterImageBinding;
  maskTexture: number | null;
  timed: boolean;
  record: EmitterImageRecord;
  ledger: SnapshotLedger;
  slot: Slot | null;
  /** `mask` 纹理的视图缓存（上传是同步的，取一次就定；没有 `mask` 或纹理缺了为 null，没取过为 undefined）。 */
  mask?: EmitterImageMaskTexture | null;
}

/** 本帧拷过、等 `afterSubmit` 读回的一份。 */
interface PendingCopy {
  entry: SnapshotEntry;
  buffer: GPUBuffer;
  w4: number;
  h4: number;
  width: number;
  height: number;
  bytesPerRow: number;
}

/** dev 探针一条记录的读数（`host.emitterImages()`）。 */
export interface EmitterImageProbe {
  id: number;
  mask: string;
  state: 0 | 1 | 2;
  started: boolean;
  startFrame: number;
  /** 建表时的合成 RT 尺寸（状态 2 之前是 0）。 */
  width: number;
  height: number;
  /** 降采样尺寸（按当前被依赖图层的合成 RT 尺寸算，图层没有独占 RT 时为 0）。 */
  w4: number;
  h4: number;
  count: number;
  /** `[x, y, r, g, b][]`，只在 `includeEntries` 时给。 */
  entries?: number[][];
}

const FORMAT: GPUTextureFormat = "rgba8unorm";

export class GpuEmitterImages implements EmitterImageView {
  readonly records: EmitterImageRecords;
  private readonly gpu = new Map<string, GpuRecord>();
  private readonly variants: { plain?: Variant; masked?: Variant } = {};
  private readonly free = new Map<number, GPUBuffer[]>();
  private readonly allBuffers = new Set<GPUBuffer>();
  private copies: PendingCopy[] = [];
  private inflight = new Set<Promise<void>>();
  private frame = 0;
  private destroyed = false;

  private constructor(private readonly input: GpuEmitterImagesInput) {
    this.records = new EmitterImageRecords(this);
  }

  /** 建降采样管线（有哪个变体的 pass 建哪个）并登记 bundle 里全部粒子系统的绑定。 */
  static async create(input: GpuEmitterImagesInput, systems: Iterable<SceneParticle> = []): Promise<GpuEmitterImages> {
    const images = new GpuEmitterImages(input);
    const quad = fullscreenTriangle();
    for (const key of ["plain", "masked"] as const) {
      const pass = input.passes?.[key];
      const program = pass && pass.program !== null ? input.programs.get(pass.program) : undefined;
      if (!pass || !program) continue;
      const data = program.vertexPacking.pack(quad);
      const vertexBuffer = input.device.createBuffer({
        label: `emitter image ${key}`,
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      input.device.queue.writeBuffer(vertexBuffer, 0, data);
      images.allBuffers.add(vertexBuffer);
      images.variants[key] = { pass, program, pipeline: await input.pipelineFor(program, null, FORMAT), vertexBuffer };
    }
    for (const system of systems) images.register(system);
    return images;
  }

  /**
   * 登记一个粒子系统（含子系统）的绑定：按 `(id, mask)` 去重；第 k 个 `layerimage` 发射器取 `emitterImages[k]`，带 `0x20000` 的记 `timed`。
   * 幂等：建场景时登记全部、运行中新建粒子层（`createParticleTree`）时再登记一次。
   */
  register(system: SceneParticle): void {
    const emitters = system.emitters.filter((emitter) => emitter.name === "layerimage");
    (system.emitterImages ?? []).forEach((slot, k) => {
      if (!slot) return;
      this.ensure(slot, (Number(emitters[k]?.fields.flags) & 0x20000) !== 0);
    });
    for (const child of system.children ?? []) this.register(child.system);
  }

  private ensure(binding: EmitterImageBinding & { maskTexture?: number | null }, timed: boolean): GpuRecord {
    const key = `${binding.id}\0${binding.mask}`;
    let rec = this.gpu.get(key);
    if (!rec) {
      const plain = { id: binding.id, mask: binding.mask };
      rec = {
        binding: plain,
        maskTexture: binding.maskTexture ?? null,
        timed,
        record: this.records.record(plain),
        ledger: new SnapshotLedger(),
        slot: null,
      };
      this.gpu.set(key, rec);
    } else {
      rec.timed ||= timed;
      rec.maskTexture ??= binding.maskTexture ?? null;
    }
    return rec;
  }

  layerSize(id: number): { width: number; height: number } | null {
    const source = this.input.layerSource(id);
    return source ? { width: source.width, height: source.height } : null;
  }

  lock(id: number, mask: string, frame: number): EmitterImageHandle | null {
    return this.ensure({ id, mask }, false).ledger.lock(frame);
  }

  /** 渲染帧号（`GpuScene.stepParticles` 每帧写，同 WPE `ctx+0x144`）：快照按它标记「第几帧末」。 */
  setFrame(frame: number): void {
    this.frame = frame;
  }

  /** 全部记录的读数（dev 探针）。 */
  probe(includeEntries = false): EmitterImageProbe[] {
    return [...this.records.all()].map((record) => {
      const source = this.input.layerSource(record.id);
      const size = source ? emitterImageSize(source.width, source.height) : { w4: 0, h4: 0 };
      const table = record.table;
      const item: EmitterImageProbe = {
        id: record.id,
        mask: record.mask,
        state: record.state,
        started: record.started,
        startFrame: record.startFrame,
        width: record.width,
        height: record.height,
        w4: size.w4,
        h4: size.h4,
        count: table?.count ?? 0,
      };
      if (includeEntries && table)
        item.entries = Array.from({ length: table.count }, (_, i) => [
          table.x[i],
          table.y[i],
          table.rgb[i * 3],
          table.rgb[i * 3 + 1],
          table.rgb[i * 3 + 2],
        ]);
      return item;
    });
  }

  /** 每帧编码的最末尾（全部图层画完之后）：给需要快照的记录降采样并拷进可读缓冲。 */
  encode(encoder: GPUCommandEncoder): void {
    if (this.destroyed) return;
    for (const rec of this.gpu.values()) {
      const wanted = rec.ledger.wantedAt(this.frame);
      if (
        !needsSnapshot({
          started: rec.record.started,
          state: rec.record.state,
          timed: rec.timed,
          wanted: wanted !== null,
        })
      )
        continue;
      // 同一帧编码两次（探针重复编码读回）：已经拍过这一帧，不重复
      if (!wanted && rec.ledger.latest?.frame === this.frame) continue;
      const source = this.input.layerSource(rec.binding.id);
      if (!source) continue;
      const slot = this.slotOf(rec, source);
      if (!slot) continue;
      const entry = wanted ?? { frame: this.frame, snapshot: null };
      const pass = encoder.beginRenderPass({
        label: `emitter image ${rec.binding.id}`,
        colorAttachments: [{ view: slot.view, loadOp: "clear", clearValue: [0, 0, 0, 0], storeOp: "store" }],
      });
      pass.setPipeline(slot.variant.pipeline);
      pass.setBindGroup(0, slot.bindGroup);
      pass.setVertexBuffer(0, slot.variant.vertexBuffer);
      pass.draw(3);
      pass.end();
      const bytesPerRow = paddedBytesPerRow(slot.w4);
      const buffer = this.takeBuffer(bytesPerRow * slot.h4);
      encoder.copyTextureToBuffer(
        { texture: slot.texture },
        { buffer, bytesPerRow, rowsPerImage: slot.h4 },
        { width: slot.w4, height: slot.h4 },
      );
      this.copies.push({
        entry,
        buffer,
        w4: slot.w4,
        h4: slot.h4,
        width: source.width,
        height: source.height,
        bytesPerRow,
      });
      rec.ledger.record(entry);
    }
  }

  /** 每次 `queue.submit` 之后：对本帧拷过的缓冲 `mapAsync`，读完去掉行尾填充、交给对应条目、还缓冲。 */
  afterSubmit(): void {
    const copies = this.copies;
    this.copies = [];
    for (const copy of copies) {
      const task: Promise<void> = copy.buffer
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const raw = new Uint8Array(copy.buffer.getMappedRange());
          copy.entry.snapshot = {
            pixels: compactRows(raw, copy.w4, copy.h4, copy.bytesPerRow),
            w4: copy.w4,
            h4: copy.h4,
            width: copy.width,
            height: copy.height,
          };
          copy.buffer.unmap();
          this.giveBuffer(copy.buffer);
        })
        .catch(() => {
          // 场景销毁、设备丢失：缓冲已经没了，条目留空（状态机留在状态 1）
        })
        .finally(() => this.inflight.delete(task));
      this.inflight.add(task);
    }
  }

  /** 等全部在途的读回（探针的确定性回放用）。 */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  destroy(): void {
    this.destroyed = true;
    for (const rec of this.gpu.values()) this.dropSlot(rec);
    for (const buffer of this.allBuffers) buffer.destroy();
    this.allBuffers.clear();
    this.free.clear();
    this.copies = [];
  }

  private takeBuffer(size: number): GPUBuffer {
    const pooled = this.free.get(size)?.pop();
    if (pooled) return pooled;
    const buffer = this.input.device.createBuffer({
      label: "emitter image readback",
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.allBuffers.add(buffer);
    return buffer;
  }

  private giveBuffer(buffer: GPUBuffer): void {
    if (this.destroyed || !this.allBuffers.has(buffer)) return;
    const list = this.free.get(buffer.size) ?? [];
    list.push(buffer);
    this.free.set(buffer.size, list);
  }

  private dropSlot(rec: GpuRecord): void {
    rec.slot?.texture.destroy();
    rec.slot?.uniformBuffer?.destroy();
    rec.slot = null;
  }

  /** 这条记录当前的降采样目标与 bind group：来源 RT、变体或尺寸变了重建。pass 或纹理槽不全时为 null（这条记录不拍）。 */
  private slotOf(rec: GpuRecord, source: EmitterImageSourceTarget): Slot | null {
    if (rec.mask === undefined)
      rec.mask = rec.binding.mask && rec.maskTexture !== null ? this.input.maskTexture(rec.maskTexture) : null;
    const mask = rec.mask;
    // 有 `mask` 且纹理就绪用带遮罩的变体；纹理缺了（读不到）退回不带遮罩的
    const variant = (mask && this.variants.masked) || this.variants.plain;
    if (!variant) return null;
    const { w4, h4 } = emitterImageSize(source.width, source.height);
    const old = rec.slot;
    if (old && old.source === source.texture && old.variant === variant && old.w4 === w4 && old.h4 === h4) return old;
    this.dropSlot(rec);
    const { device } = this.input;
    const { program, pass } = variant;
    const texture = device.createTexture({
      label: `emitter image ${rec.binding.id}`,
      size: { width: w4, height: h4 },
      format: FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const entries: GPUBindGroupEntry[] = [];
    let uniformBuffer: GPUBuffer | null = null;
    if (program.uniformSize) {
      const block = new UniformBlock((program.result.uniforms ?? []) as UniformEntry[], program.uniformSize);
      const values: Record<string, number[]> = {
        ...screenBuiltins([w4, h4]),
        ...textureBuiltins([
          { width: source.width, height: source.height, textureWidth: source.width, textureHeight: source.height },
          ...(variant === this.variants.masked && mask
            ? [{ width: mask.width, height: mask.height, textureWidth: mask.width, textureHeight: mask.height }]
            : []),
        ]),
        ...pass.uniforms,
      };
      for (const [name, value] of Object.entries(values)) block.set(name, value);
      uniformBuffer = device.createBuffer({
        label: `emitter image ${rec.binding.id}`,
        size: block.data.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(uniformBuffer, 0, block.data);
      entries.push({ binding: 0, resource: { buffer: uniformBuffer } });
    }
    for (const binding of program.textures) {
      const from = binding.slot === 0 ? source : binding.slot === 1 ? mask : null;
      if (!from || binding.kind !== "2d") {
        texture.destroy();
        uniformBuffer?.destroy();
        return null;
      }
      entries.push({ binding: binding.binding, resource: from.view });
      entries.push({ binding: binding.samplerBinding, resource: from.sampler });
    }
    rec.slot = {
      source: source.texture,
      variant,
      w4,
      h4,
      texture,
      view: texture.createView(),
      bindGroup: device.createBindGroup({
        label: `emitter image ${rec.binding.id}`,
        layout: program.bindGroupLayout,
        entries,
      }),
      uniformBuffer,
    };
    return rec.slot;
  }
}
