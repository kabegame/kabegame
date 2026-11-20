/**
 * 脚本模型数据的数据仓（P14 步骤 1）：「内存里的 mdl」。按 token 存每个形状的格式、材质、顶点 / 索引字节、动态标志、版本与包围盒；
 * 脚本 API（`script/modelData.ts`）只和它打交道，GPU 缓冲按版本取字节。规则照 rea-p14-exe（3.1 `FUN_1401d6400` 的判断顺序、4.3 引用计数），
 * 其中 WPE 缺陷 D3–D9 按文档意图实现（见 `phase-14-model-data.md`「步骤 0 的结论」）。
 */

import { mdlStride } from "../compile/mdl";
import type {
  MaterialCheck,
  ModelDataDesc,
  ModelDataIndexFormat,
  ModelDataInput,
  ModelDataShape,
  ModelDataShapeDesc,
  ModelDataShapeInput,
  ModelDataUpdate,
} from "./types";
import { MODEL_DATA_FORMAT_BITS } from "./types";

/** exe 错误码 → 文字（rea-p14-script 9.1；码 5 / 6 是 D3 的正确文字，WPE 里走不到）。码 0 是 dll 侧的校验。 */
const ERROR_TEXT: Readonly<Record<number, string>> = {
  1: "Invalid material",
  2: "Shader expecting more vertex data.",
  3: "Inconsistent vertex buffer size",
  4: "Invalid model data token",
  5: "Vertex buffer size cannot increase",
  6: "Index buffer size cannot increase",
  7: "Model data not created as dynamic",
  8: "Buffer lock failed",
  9: "Incorrect index buffer type",
  10: "Cannot add shapes in IModelData.update",
  11: "Cannot delete shape or buffers in IModelData.update",
  12: "Material cannot be changed in IModelData.update",
  13: "Vertex format cannot be changed in IModelData.update",
};

/** 数据仓抛出的错误：`code` 是 exe 的错误码（1–13），dll 侧自己的校验是 0；`message` 逐字照 WPE。脚本层转成 realm 的 `SyntaxError`。 */
export class ModelDataError extends Error {
  constructor(
    readonly code: number,
    message: string = ERROR_TEXT[code] ?? "",
  ) {
    super(message);
    this.name = "ModelDataError";
  }
}

/** 没有位置分量（或没有顶点）时的包围盒：同 mdl v<17「不剔除」的 ±131072 约定。 */
const NO_CULL = 131072;

interface ShapeRecord {
  format: number;
  stride: number;
  material: string;
  dynamicVertex: boolean;
  dynamicIndex: boolean;
  /** 整块容量：长度即建 / 重建时的容量 */
  vertices: Uint8Array;
  indices: Uint8Array | null;
  indexFormat: ModelDataIndexFormat | null;
  drawCount: number;
  version: number;
}

interface ModelDataEntry {
  shapes: ShapeRecord[];
  bounds: number[];
  /** 脚本那一份引用还在（`destroyModelData` 只释放一次，D9） */
  scriptRef: boolean;
  /** 用它的图层（每个图层一份引用） */
  layers: Set<number>;
}

interface IndexInput {
  format: ModelDataIndexFormat;
  bytes: Uint8Array;
}

const indexBytesOf = (format: ModelDataIndexFormat): number => (format === "uint16" ? 2 : 4);

const copyOf = (view: Uint8Array): Uint8Array => view.slice();

const sameMaterial = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const indexCapacity = (shape: ShapeRecord): number =>
  shape.indices && shape.indexFormat ? shape.indices.byteLength / indexBytesOf(shape.indexFormat) : 0;

const indexCountOf = (index: IndexInput): number => index.bytes.byteLength / indexBytesOf(index.format);

export class ModelDataStore {
  /** E15：从 1 起，只在成功时分配，不复用 */
  private next = 1;
  private readonly entries = new Map<number, ModelDataEntry>();
  /** 结构变了（形状数、格式、材质、容量、索引有无）时通知：GPU 场景重建缓冲，宿主重拼用它的图层 */
  onStructure: ((token: number) => void) | null = null;
  onRelease: ((token: number) => void) | null = null;

  /**
   * 创建：校验通过的输入，拷贝字节。每个形状都处理完、留最后一个错误码再失败（同 WPE，出错不跳出）；失败不分配 token。
   */
  create(input: ModelDataInput, check: MaterialCheck): number {
    if (input.shapes.length === 0) throw new ModelDataError(0, "Shapes missing.");
    let error = 0;
    const shapes: ShapeRecord[] = [];
    for (const shape of input.shapes) {
      const record = this.record(shape);
      if (record.stride === 0 || record.vertices.byteLength % record.stride !== 0) error = 3;
      const checked = check(shape.material, shape.format);
      if (checked !== 0) error = checked;
      shapes.push(record);
    }
    if (error !== 0) throw new ModelDataError(error);
    const token = this.next++;
    this.entries.set(token, {
      shapes,
      bounds: input.bounds ? [...input.bounds] : positionBounds(shapes),
      scriptRef: true,
      layers: new Set(),
    });
    return token;
  }

  private record(shape: ModelDataShapeInput): ShapeRecord {
    const stride = mdlStride(shape.format);
    const vertices = copyOf(shape.vertices);
    const indices = shape.index ? copyOf(shape.index.bytes) : null;
    const indexFormat = shape.index ? shape.index.format : null;
    const vertexCount = stride > 0 ? Math.floor(vertices.byteLength / stride) : 0;
    const indexCount = indices && indexFormat ? indices.byteLength / indexBytesOf(indexFormat) : 0;
    return {
      format: shape.format,
      stride,
      material: shape.material,
      dynamicVertex: shape.dynamicVertex,
      dynamicIndex: shape.dynamicIndex,
      vertices,
      indices,
      indexFormat,
      // 有索引 = 索引个数（为 0 时取顶点数，rea-p14-exe 2.3），无索引 = 顶点数
      drawCount: indices && indexCount > 0 ? indexCount : vertexCount,
      version: 0,
    };
  }

  /**
   * applyData（rea-p14-exe 3.1 的判断顺序）：只覆盖已有形状的给出部分，不许加 / 删形状、删缓冲、换材质、换格式、写非动态缓冲、超过建时容量。
   * 出错时前面已处理的形状不回滚（同 WPE）。
   */
  apply(token: number, updates: readonly ModelDataUpdate[]): void {
    const entry = this.entries.get(token);
    if (!entry) throw new ModelDataError(4);
    if (updates.length > entry.shapes.length) throw new ModelDataError(10);
    let deferred = 0;
    for (let i = 0; i < updates.length; i++) {
      const update = updates[i];
      const shape = entry.shapes[i];
      if (update.deleteShape || update.dropIndex) throw new ModelDataError(11);
      if (update.material && !sameMaterial(update.material, shape.material)) throw new ModelDataError(12);
      if (update.format && update.format !== shape.format) throw new ModelDataError(13);
      const index = update.index;
      if ((update.vertices && !shape.dynamicVertex) || (index && !shape.dynamicIndex)) throw new ModelDataError(7);
      // D3：变长报 5 / 6（WPE 这里误报 7）
      if (update.vertices && update.vertices.byteLength > shape.vertices.byteLength) throw new ModelDataError(5);
      if (index && indexCountOf(index) > indexCapacity(shape)) throw new ModelDataError(6);
      if (index && index.format !== shape.indexFormat) {
        // 索引类型与网格不同：顶点照传（同 exe 先传顶点再查索引），留着码 9 继续处理后面的形状
        upload(shape, update.vertices, undefined);
        deferred = 9;
        continue;
      }
      upload(shape, update.vertices, index);
    }
    if (deferred !== 0) throw new ModelDataError(deferred);
  }

  /**
   * replaceData：可加 / 删形状、换材质、换格式、变长与改动态标志（重建该形状）；没写格式就沿用原格式（D8）；不改包围盒。
   * 出错时已处理的形状保留、不做删除，并照常通知结构变化（同 WPE）。
   */
  replace(token: number, updates: readonly ModelDataUpdate[], check: MaterialCheck): void {
    const entry = this.entries.get(token);
    if (!entry) throw new ModelDataError(4);
    const original = entry.shapes.length;
    const deletes: number[] = [];
    let changed = false;
    try {
      for (let i = 0; i < updates.length; i++) {
        const update = updates[i];
        if (update.deleteShape) {
          if (i < original) deletes.push(i);
          continue;
        }
        if (i >= original) {
          // 超出原有数量的一律追加在末尾
          entry.shapes.push(this.appended(update, check));
          changed = true;
          continue;
        }
        this.replaceShape(
          entry.shapes[i],
          update,
          check,
          (next) => (entry.shapes[i] = next),
          () => (changed = true),
        );
      }
      for (let k = deletes.length - 1; k >= 0; k--) {
        entry.shapes.splice(deletes[k], 1);
        changed = true;
      }
    } finally {
      if (changed) this.onStructure?.(token);
    }
  }

  /** 新加的形状：按创建规则校验（缺顶点 / 格式 / 材质照 dll 的文字，码 0）。 */
  private appended(update: ModelDataUpdate, check: MaterialCheck): ShapeRecord {
    if (!update.vertices) throw new ModelDataError(0, "Vertex buffer missing.");
    if (!update.format) throw new ModelDataError(0, "Vertex format missing.");
    if (!update.material) throw new ModelDataError(0, "Material missing.");
    const record = this.record({
      vertices: update.vertices,
      index: update.index ?? null,
      format: update.format,
      material: update.material,
      dynamicVertex: update.dynamicVertex ?? false,
      dynamicIndex: update.dynamicIndex ?? false,
    });
    if (record.stride === 0 || record.vertices.byteLength % record.stride !== 0) throw new ModelDataError(3);
    const checked = check(record.material, record.format);
    if (checked !== 0) throw new ModelDataError(checked);
    return record;
  }

  /** 结构变了（材质、重建）时先调 `changed` 再做可能抛错的检查。重建失败（码 3）不换记录；材质检查失败时先换上新记录再抛（同 WPE）。 */
  private replaceShape(
    shape: ShapeRecord,
    update: ModelDataUpdate,
    check: MaterialCheck,
    install: (next: ShapeRecord) => void,
    changed: () => void,
  ): void {
    const materialChanged = !!update.material && !sameMaterial(update.material, shape.material);
    const material = materialChanged ? (update.material as string) : shape.material;
    const format = update.format ? update.format : shape.format; // D8：没写格式沿用原格式
    const dynamicVertex = update.dynamicVertex ?? shape.dynamicVertex;
    const dynamicIndex = update.dynamicIndex ?? shape.dynamicIndex;
    const index = update.index;
    const rebuild =
      format !== shape.format ||
      dynamicVertex !== shape.dynamicVertex ||
      dynamicIndex !== shape.dynamicIndex ||
      (update.vertices !== undefined &&
        (update.vertices.byteLength > shape.vertices.byteLength || !shape.dynamicVertex)) ||
      (index !== undefined &&
        (!shape.dynamicIndex || indexCountOf(index) > indexCapacity(shape) || index.format !== shape.indexFormat)) ||
      (update.dropIndex === true && shape.indices !== null);
    if (!rebuild) {
      if (update.vertices || index) upload(shape, update.vertices, index);
      if (materialChanged) {
        shape.material = material;
        shape.version++;
        changed();
        const checked = check(material, shape.format);
        if (checked !== 0) throw new ModelDataError(checked);
      }
      return;
    }
    const stride = mdlStride(format);
    const vertices = update.vertices ? copyOf(update.vertices) : shape.vertices;
    if (stride === 0 || vertices.byteLength % stride !== 0) throw new ModelDataError(3);
    let indices: Uint8Array | null = null;
    let indexFormat: ModelDataIndexFormat | null = null;
    if (!update.dropIndex) {
      if (index) {
        indices = copyOf(index.bytes);
        indexFormat = index.format;
      } else if (shape.indices) {
        indices = shape.indices;
        indexFormat = shape.indexFormat;
      }
    }
    const vertexCount = Math.floor(vertices.byteLength / stride);
    const indexCount = indices && indexFormat ? indices.byteLength / indexBytesOf(indexFormat) : 0;
    install({
      format,
      stride,
      material,
      dynamicVertex,
      dynamicIndex,
      vertices,
      indices,
      indexFormat,
      drawCount: indices && indexCount > 0 ? indexCount : vertexCount,
      version: shape.version + 1,
    });
    changed();
    const checked = check(material, format);
    if (checked !== 0) throw new ModelDataError(checked);
  }

  /** 脚本那一份引用（`destroyModelData`）：每个 token 只生效一次（D9）；查不到静默。 */
  releaseScript(token: number): void {
    const entry = this.entries.get(token);
    if (!entry || !entry.scriptRef) return;
    entry.scriptRef = false;
    this.collect(token, entry);
  }

  /** 图层引用 +1（同一个对象只记一份）；查不到返回 false：图层照建、不画（S16）。 */
  retainLayer(token: number, object: number): boolean {
    const entry = this.entries.get(token);
    if (!entry) return false;
    entry.layers.add(object);
    return true;
  }

  releaseLayer(token: number, object: number): void {
    const entry = this.entries.get(token);
    if (!entry || !entry.layers.delete(object)) return;
    this.collect(token, entry);
  }

  /** 引用数到 0：删掉并通知（token 不复用）。 */
  private collect(token: number, entry: ModelDataEntry): void {
    if (entry.scriptRef || entry.layers.size > 0) return;
    this.entries.delete(token);
    this.onRelease?.(token);
  }

  /** 现在引用这个 token 的图层（`objects` 下标，按登记顺序）；`replaceData` 改了结构后宿主据此重拼（P14 步骤 3a）。 */
  layersOf(token: number): number[] {
    return [...(this.entries.get(token)?.layers ?? [])];
  }

  desc(token: number): ModelDataDesc | null {
    const entry = this.entries.get(token);
    if (!entry) return null;
    return {
      token,
      shapes: entry.shapes.map((shape): ModelDataShapeDesc => ({
        format: shape.format,
        vertexCount: Math.floor(shape.vertices.byteLength / shape.stride),
        indexFormat: shape.indexFormat,
        indexCount: indexCapacity(shape),
        material: shape.material,
      })),
      bounds: [...entry.bounds],
    };
  }

  shape(token: number, shape: number): ModelDataShape | null {
    const record = this.entries.get(token)?.shapes[shape];
    if (!record) return null;
    return { vertices: record.vertices, indices: record.indices, drawCount: record.drawCount, version: record.version };
  }
}

/**
 * 就地上传：只覆盖给出的前缀（D4，余下保持旧值）、版本 +1。绘制数（D5）：有索引网格给了索引就是这次的索引个数，只给顶点不变；
 * 无索引网格是这次的顶点数（不足一个顶点时不变）。
 */
function upload(shape: ShapeRecord, vertices: Uint8Array | undefined, index: IndexInput | undefined): void {
  let touched = false;
  if (vertices) {
    shape.vertices.set(vertices);
    touched = true;
    if (!shape.indices) {
      const count = Math.floor(vertices.byteLength / shape.stride);
      if (count > 0) shape.drawCount = count;
    }
  }
  if (index && shape.indices) {
    shape.indices.set(index.bytes);
    touched = true;
    const count = indexCountOf(index);
    if (count > 0) shape.drawCount = count;
  }
  if (touched) shape.version++;
}

/** 没给包围盒：只取位置分量（D6）求并集；没有位置分量的格式、没有顶点时 ±131072。 */
function positionBounds(shapes: readonly ShapeRecord[]): number[] {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const shape of shapes) {
    if (!(shape.format & MODEL_DATA_FORMAT_BITS.position) || shape.stride === 0) continue;
    const view = new DataView(shape.vertices.buffer, shape.vertices.byteOffset, shape.vertices.byteLength);
    const count = Math.floor(shape.vertices.byteLength / shape.stride);
    for (let v = 0; v < count; v++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = view.getFloat32(v * shape.stride + axis * 4, true);
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
      any = true;
    }
  }
  return any ? [...min, ...max] : [-NO_CULL, -NO_CULL, -NO_CULL, NO_CULL, NO_CULL, NO_CULL];
}
