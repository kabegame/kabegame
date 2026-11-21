/**
 * `layerimage` 发射器的候选表（P4j 步骤 2a，`rea-p4j-layerimage.md` 第 2 节、3.1）。
 *
 * WPE 的候选表走「过门 → 渲染拷贝 → 读回建表」三步，都在发射调用里同步推进（`FUN_1401d3ae0`，2.1）：状态 0 在更新阶段把被依赖图层
 * 合成 RT 里**上一帧末的画面**降采样拷进 staging，状态 1 同步 `Map` 读回、建表。我们的模拟在 CPU 上同步跑，WebGPU 读回只能异步，
 * 所以拆成两半：
 * - **画面（GPU，步骤 2b）**：渲染器每帧编码末尾给需要快照的记录降采样、读回，交出 `EmitterImageSnapshot`；
 * - **状态机（本文件，纯 TS）**：照 2.1 逐条。状态 0 那次调用不再「当场渲染」，改为**锁定快照**——上一帧末有就锁它，没有就锁「本帧末」
 *   的那份（只出在加载后的第一帧：预热在加载时就过了门，WPE 的第一帧更新读的是加载那一帧画出的内容，我们没有那一帧）；状态 1 的
 *   调用在锁定的快照读回之后才建表，没读回就留在状态 1、返回旧表，下一个发射帧再试。WPE 这里阻塞等 GPU，产品里表晚到就晚几帧
 *   开始发射，是已知差异；确定性回放在每帧提交之后等读回，保证同一帧里「0 → 1 → 2」和 WPE 一样成立。
 *
 * 一条记录按 `(图层 id, mask)` 共享（1.6）：跨发射器、跨粒子对象；同一帧里后调的发射器接着推进状态（门只挡「第一次」与「同一帧」）。
 * `0x20000` 的计时器（2.5，`rec+0x7c`）是**发射器记录**的字段（同一记录 `+0x78` 是槽号），每个发射器各一个，在 `ParticleSystem` 的发射循环
 * 里累加；过 1 时调共享记录的 `refresh`，所以任何一个带 `0x20000` 的发射器都会让共享表重建，但两个发射器不会把一个计时器累加成两倍速。
 *
 * 发射循环在要发的帧（`n > 0`）走一次 `0x20000` 计时（带这一位时）与 `acquire`，取到表就按它生粒子（步骤 3，`emitters.ts` 的 `layerImage`）。
 */
import { f32 } from "./f32";
import { identity, type Mat4 } from "../render/math";

/** 候选表（2.3）：列优先（x 外层、y 内层），每项一个像素。x / y 是 int16（合成 RT 像素，原点在中心，y 向下），rgb 是降采样后的 8 位值。 */
export interface EmitterImageTable {
  count: number;
  x: Int16Array;
  y: Int16Array;
  /** 3 × count，r、g、b 交错。 */
  rgb: Uint8Array;
}

/** 一次快照：降采样后紧凑的 RGBA8（`w4 × h4`，行优先）与源合成 RT 的尺寸。 */
export interface EmitterImageSnapshot {
  pixels: Uint8Array;
  w4: number;
  h4: number;
  /** 合成 RT 的宽高（u16）：`s` 与坐标偏移用。 */
  width: number;
  height: number;
}

const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;
/** 16:9（float32）：`a ≥ 1.7777778` 时按宽压（2.2，`0x1401d3caa` 起）。 */
const WIDE = f32(1.7777778);
/** 候选项的 alpha 门：`< 0x7f` 跳过（`0x1401d411d`）。 */
const ALPHA_MIN = 127;

/**
 * 降采样 RT 的尺寸（2.2）：宽或高超过 3840 × 2160 时先按宽高比压（比较与除法都是 float32、`cvttss2si` 截断），
 * `w4 = max(2, W′ / 4)`、`h4 = max(2, H′ / 4)`（有符号整除，向 0 截断）。
 */
export function emitterImageSize(width: number, height: number): { w4: number; h4: number } {
  let w = width;
  let h = height;
  if (width > MAX_WIDTH || height > MAX_HEIGHT) {
    const a = f32(f32(width) / f32(height));
    if (a >= WIDE) {
      w = MAX_WIDTH;
      h = Math.trunc(f32(f32(MAX_WIDTH) / a));
    } else {
      w = Math.trunc(f32(a * f32(MAX_HEIGHT)));
      h = MAX_HEIGHT;
    }
  }
  return { w4: Math.max(2, Math.trunc(w / 4)), h4: Math.max(2, Math.trunc(h / 4)) };
}

/**
 * 建表（2.3，`0x1401d4073`–`0x1401d4249`）：`s = f32(W) / f32(w4)`（只算 x 方向，y 也用它）、`hs = s · 0.5`；x 外层、y 内层，
 * alpha < 127 跳过，其余一项一个像素：`x′ = (i16) trunc((s·x − (W >> 1)) + hs)`，y 同式（`H >> 1`）。浮点逐步 float32。
 */
export function buildEmitterImageTable(snapshot: EmitterImageSnapshot): EmitterImageTable {
  const { pixels, w4, h4, width, height } = snapshot;
  const s = f32(f32(width) / f32(w4));
  const hs = f32(s * 0.5);
  const halfW = f32(width >> 1);
  const halfH = f32(height >> 1);
  const capacity = w4 * h4;
  const x = new Int16Array(capacity);
  const y = new Int16Array(capacity);
  const rgb = new Uint8Array(capacity * 3);
  let count = 0;
  for (let column = 0; column < w4; column++) {
    const px = Math.trunc(f32(f32(f32(s * f32(column)) - halfW) + hs));
    for (let row = 0; row < h4; row++) {
      const i = (row * w4 + column) * 4;
      if (pixels[i + 3] < ALPHA_MIN) continue;
      x[count] = px;
      y[count] = Math.trunc(f32(f32(f32(s * f32(row)) - halfH) + hs));
      rgb[count * 3] = pixels[i];
      rgb[count * 3 + 1] = pixels[i + 1];
      rgb[count * 3 + 2] = pixels[i + 2];
      count++;
    }
  }
  return { count, x: x.slice(0, count), y: y.slice(0, count), rgb: rgb.slice(0, count * 3) };
}

/**
 * 一次取表的结果（步骤 3）：候选表与被依赖图层的绘制矩阵 `L`（记录的 `dep+0x98`，rea 2.1：只在状态 2 的调用与建表时刷新，重建期间照用旧的）。
 * 发射器用 `A = M⁻¹·L`（本地）或 `L`（世界）搬出生点，`L` 也是下一帧速度的「上一次图层矩阵」。
 */
export interface EmitterImageAcquired {
  table: EmitterImageTable;
  matrix: Mat4;
}

/**
 * 一个发射器一帧的发射输入（步骤 3，rea 3.2 的矩阵准备）：取到表的发射帧由 `ParticleSystem.emit` 算好，交给 `layerImage` 逐颗粒子用。
 * - `A`：出生点矩阵，世界系统 `L`（`I·L`），本地系统 `M⁻¹·L`；
 * - `prev`：`Bprev = Ap·rec[0xb8]`，`Ap` 世界单位阵、本地 `M⁻¹`，速度算「上一次取到表时图层矩阵」下的出生点用；
 * - `frameDt`：`ctx+0x14c`，不含实例 `rate` 的帧时间（速度的除数）。
 */
export interface LayerImageFrame {
  table: EmitterImageTable;
  A: Mat4;
  prev: Mat4;
  frameDt: number;
}

/** 一条绑定（编译期 `SceneParticle.emitterImages` 的一项去掉 `maskTexture`）：共享记录的键。 */
export interface EmitterImageBinding {
  id: number;
  mask: string;
}

/** 锁定下来的一份快照：读回完成前 `snapshot()` 返回 null。 */
export interface EmitterImageHandle {
  snapshot(): EmitterImageSnapshot | null;
}

/** 状态机向场景问的两件事（渲染器实现 GPU 那半，单测与回放用 `ScriptedEmitterImageView`）。 */
export interface EmitterImageView {
  /** 图层是图像层且有独占合成 RT 时返回 RT 的宽高，否则 null（1.7、2.1 开头：不过门）。 */
  layerSize(id: number): { width: number; height: number } | null;
  /**
   * 状态 0 的「锁定快照」：`frame` 的上一帧末有就锁它，没有就锁本帧末的那份；两者都没法给时返回 null（留在状态 0）。
   */
  lock(id: number, mask: string, frame: number): EmitterImageHandle | null;
  /**
   * 图层此刻的绘制矩阵 `L`（`FUN_1401d3ae0` 里的 `L.vfunc_0x80()`，rea 3.2：世界矩阵含父链、`angles`、`scale`，再右乘 `alignment` 偏移）。
   * 状态 2 的每次调用与建表时现取；图层找不到时返回 null（记录保留上一份）。`frame` 给回放用（脚本移动图层的案例按帧号算）。
   */
  layerMatrix(id: number, frame: number): Mat4 | null;
}

/** 发射循环看到的来源（每个场景一份）。 */
export interface EmitterImageSource {
  /** 第 `frame` 帧、某个发射器取表（`n > 0` 的帧才调）：返回可用的非空表与图层矩阵，或 null。 */
  acquire(binding: EmitterImageBinding, frame: number): EmitterImageAcquired | null;
  /**
   * `0x20000` 的重建（2.5，`FUN_1401d42b0`）：记录状态不是 1 就置 0。计时器在发射器上（`rec+0x7c` 是发射器记录的偏移，每个发射器
   * 各一个，`ParticleSystem` 的发射循环里累加），过 1 时调这里；记录是共享的，所以任何一个带 `0x20000` 的发射器都会让共享表重建。
   */
  refresh(binding: EmitterImageBinding): void;
}

/**
 * 一条记录（rea 1.6）。状态机照 2.1：
 * - 图层不存在 / 不是图像层 / 没有独占 RT：返回 null，不过门；
 * - 状态 2：当前合成 RT 尺寸与建表时不同就回状态 0（返回旧表）；
 * - 门：`started` 为假，或 `startFrame === frame` 时记下并返回 null（只挡第一次与同一帧，之后不再清）；
 * - 状态 0：锁定快照，进状态 1，返回旧表（没有为 null）；
 * - 状态 1：锁定的快照读回了就建表、记 W / H，进状态 2；没读回留在状态 1（同 WPE 重建期间照用旧表）；
 * - 返回的表为空时返回 null（WPE「表非空才发」，3.1）；
 * - 图层矩阵 `matrix`（`rec+0x98`，2.1）：状态 2 的每次调用在尺寸检查之前刷新，建表时再刷新一次；其它状态返回上一份（解析时单位阵）。
 */
export class EmitterImageRecord {
  readonly id: number;
  readonly mask: string;
  /** 0 待渲染、1 待读回、2 有表（`rec+0x08`）。 */
  state: 0 | 1 | 2 = 0;
  /** 「已开始」与开始时的帧号（`rec+0x48` / `+0x4c`）。 */
  started = false;
  startFrame = 0;
  table: EmitterImageTable | null = null;
  /** 图层矩阵 `L`（`rec+0x98`）：初值单位阵，见类注释。 */
  matrix: Mat4 = identity();
  /** 建表时的合成 RT 尺寸（`rec+0x5c` / `+0x60`）。 */
  width = 0;
  height = 0;
  private handle: EmitterImageHandle | null = null;

  constructor(binding: EmitterImageBinding) {
    this.id = binding.id;
    this.mask = binding.mask;
  }

  acquire(frame: number, view: EmitterImageView): EmitterImageAcquired | null {
    const size = view.layerSize(this.id);
    if (!size) return null;
    if (this.state === 2) {
      this.matrix = view.layerMatrix(this.id, frame) ?? this.matrix;
      if (size.width !== this.width || size.height !== this.height) {
        this.state = 0;
        this.handle = null;
      }
      return this.current();
    }
    if (!this.started || this.startFrame === frame) {
      this.started = true;
      this.startFrame = frame;
      return null;
    }
    if (this.state === 0) {
      const handle = view.lock(this.id, this.mask, frame);
      if (handle) {
        this.handle = handle;
        this.state = 1;
      }
    } else {
      const snapshot = this.handle?.snapshot();
      if (snapshot) {
        this.table = buildEmitterImageTable(snapshot);
        this.matrix = view.layerMatrix(this.id, frame) ?? this.matrix;
        // 建表时的 W / H 是此刻合成 RT 的尺寸（2.3 末尾，`dep+0x5c/+0x60 = W/H`）
        this.width = size.width;
        this.height = size.height;
        this.handle = null;
        this.state = 2;
      }
    }
    return this.current();
  }

  /** 2.5 的重建：状态不是 1 就置 0（`FUN_1401d42b0`），表照旧留着到状态 1 才换。 */
  refresh(): void {
    if (this.state !== 1) {
      this.state = 0;
      this.handle = null;
    }
  }

  private current(): EmitterImageAcquired | null {
    return this.table && this.table.count > 0 ? { table: this.table, matrix: this.matrix } : null;
  }
}

/** 场景里全部记录，按 `(id, mask)` 共享（1.6）。 */
export class EmitterImageRecords implements EmitterImageSource {
  private readonly records = new Map<string, EmitterImageRecord>();

  constructor(private readonly view: EmitterImageView) {}

  /** 找或建（探针与测试读状态用）。 */
  record(binding: EmitterImageBinding): EmitterImageRecord {
    const key = `${binding.id}\0${binding.mask}`;
    let record = this.records.get(key);
    if (!record) this.records.set(key, (record = new EmitterImageRecord(binding)));
    return record;
  }

  all(): IterableIterator<EmitterImageRecord> {
    return this.records.values();
  }

  acquire(binding: EmitterImageBinding, frame: number): EmitterImageAcquired | null {
    return this.record(binding).acquire(frame, this.view);
  }

  refresh(binding: EmitterImageBinding): void {
    this.record(binding).refresh();
  }
}

/**
 * 单测与 Node 回放用的「假 GPU」：快照由调用方按帧号给。`snapshotAt(id, mask, frame)` 是第 `frame` 帧末的快照（还没读回时返回 null）。
 * 锁定规则同产品：上一帧末（`frame − 1`）有就锁它，没有就锁本帧末的那份（之后每次 `snapshot()` 再问，所以读回晚到也行）。
 */
export class ScriptedEmitterImageView implements EmitterImageView {
  constructor(
    private readonly options: {
      layerSize(id: number): { width: number; height: number } | null;
      snapshotAt(id: number, mask: string, frame: number): EmitterImageSnapshot | null;
      /** 第 `frame` 帧取到的图层矩阵；缺省单位阵。 */
      layerMatrix?(id: number, frame: number): Mat4 | null;
    },
  ) {}

  layerSize(id: number): { width: number; height: number } | null {
    return this.options.layerSize(id);
  }

  lock(id: number, mask: string, frame: number): EmitterImageHandle | null {
    const previous = this.options.snapshotAt(id, mask, frame - 1);
    if (previous) return { snapshot: () => previous };
    return { snapshot: () => this.options.snapshotAt(id, mask, frame) };
  }

  layerMatrix(id: number, frame: number): Mat4 | null {
    return this.options.layerMatrix ? this.options.layerMatrix(id, frame) : identity();
  }
}
