/**
 * 脚本自定义几何（`IModelData`，P14）的数据描述。编译只看描述（不带字节）；字节在宿主的 `ModelDataStore`、GPU 缓冲按版本取。
 * 行为依据：`.claude/plans/wpe-import/3-scene/phase14/`（rea-p14-script / rea-p14-exe 与步骤 0 的实测）。
 */

/** 一个形状的描述（编译用，不带字节）。stride 由格式算（`mdlStride`，E1）。 */
export interface ModelDataShapeDesc {
  format: number;
  vertexCount: number;
  /** null：没有索引，`draw(顶点数)`（E2） */
  indexFormat: "uint16" | "uint32" | null;
  indexCount: number;
  /** 经 `__workshopId` 改写后的路径（不截断，D12） */
  material: string;
}

export interface ModelDataDesc {
  token: number;
  shapes: ModelDataShapeDesc[];
  /** min xyz、max xyz：给了用给的，没给按位置分量算（D6）；建时定一次，之后不改 */
  bounds: number[];
}

/** 一个形状当前的字节与版本（GPU 缓冲按版本上传）。 */
export interface ModelDataShape {
  /** 整块容量（建 / 重建时定的长度，`applyData` 只覆盖给出的前缀，D4） */
  vertices: Uint8Array;
  indices: Uint8Array | null;
  /** 当前绘制数（有索引网格 = 索引个数，无索引 = 顶点数，D5） */
  drawCount: number;
  /** 每次字节或结构变化 +1 */
  version: number;
}

/** 顶点格式位（mdl 掩码的五项，E1）；顺序即表序（也是 d.ts 要求的顺序）。 */
export const MODEL_DATA_FORMAT_BITS = {
  position: 0x1,
  normal: 0x2,
  tangentSigned: 0x4,
  uv: 0x8,
  color: 0x8000,
} as const;

/** 材质检查：0 通过，1 = `Invalid material`，2 = `Shader expecting more vertex data.`（exe 的码 1 / 2）。 */
export type MaterialCheck = (material: string, format: number) => 0 | 1 | 2;

export type ModelDataIndexFormat = "uint16" | "uint32";

/** 创建时一个形状（dll 侧校验已由 `script/modelData.ts` 完成）。字节是视图，存储时拷贝。 */
export interface ModelDataShapeInput {
  vertices: Uint8Array;
  index: { format: ModelDataIndexFormat; bytes: Uint8Array } | null;
  format: number;
  material: string;
  dynamicVertex: boolean;
  dynamicIndex: boolean;
}

export interface ModelDataInput {
  shapes: ModelDataShapeInput[];
  /** 两个都给才有：min xyz、max xyz */
  bounds: readonly number[] | null;
}

/** `applyData` / `replaceData` 的一个形状：没给的字段不改。 */
export interface ModelDataUpdate {
  /** 形状是 `null`：删形状（`replaceData` 才许） */
  deleteShape?: boolean;
  /** `indexBuffer: null`：删索引（`replaceData` 才许） */
  dropIndex?: boolean;
  vertices?: Uint8Array;
  index?: { format: ModelDataIndexFormat; bytes: Uint8Array };
  /** 0 / 缺省：没给 */
  format?: number;
  /** 空串 / 缺省：没给 */
  material?: string;
  dynamicVertex?: boolean;
  dynamicIndex?: boolean;
}
