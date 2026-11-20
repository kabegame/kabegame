/**
 * 脚本模型数据层的纯函数部分（P14 步骤 2）：编译期（`compile/bundle.ts` 的 `compileModelData`）与主线程同步拼装（步骤 3a）共用，
 * 保证两条路编出的图层字面量与 `SceneModel` 逐字段相同。
 *
 * - `layerLiteral`：`compileOne` 里建 `SceneLayer` 字面量的那一段。绑定登记留在调用方，这里只收解析好的值；
 * - `modelDataMesh` / `modelDataModel`：由描述与每个形状的 pass 组装 `SceneMesh` / `SceneModel`（同 mdl 模型对象的规则：不透明的网格在前、
 *   投射阴影看场景有阴影且对象 `castshadow` 不为 false 且有不透明网格）。字节不在这里：`vertices` / `indices` 是空视图，`source` 指向数据仓。
 */
import type { SceneLayer, SceneMesh, SceneModel, ScenePass, SortClass } from "../compile/bundle";
import { isOpaqueBlending } from "../compile/bundle";
import type { LayerShellValues } from "../compile/layerShell";
import { mdlStride, meshDrawOrder } from "../compile/mdl";
import type { SceneObject } from "../compile/model";
import { normalizeScenePath } from "../compile/fs";
import type { ModelDataDesc, ModelDataShapeDesc } from "./types";

/**
 * 图层字面量（原 `compileOne` 的 `const layer: SceneLayer = { … }`）。`fallbackId`：JSON 没写 `id` 时取的值（编译期是 `bundle.layers.length`）。
 * `colorBlendMode` 已按属性解析并取整。
 */
export function layerLiteral(
  object: SceneObject,
  index: number,
  parent: number | null,
  shell: LayerShellValues,
  colorBlendMode: number,
  fallbackId: number,
): SceneLayer {
  return {
    id: object.id ?? fallbackId,
    object: index,
    parent,
    name: shell.name,
    origin: shell.origin,
    scale: shell.scale,
    angles: shell.angles,
    size: shell.size,
    alpha: shell.alpha,
    color: shell.color,
    brightness: shell.brightness,
    // bool setter 不收数字、字符串属性，留 `value`（`boolFieldValue`，运行时同 `SceneState.write`）
    visible: shell.visible,
    visibleBound: shell.visibleBound,
    parallaxDepth: shell.parallaxDepth,
    solidLayer: false,
    instanced: false,
    noPadding: false,
    perspective: false,
    passthroughModel: false,
    group: null,
    subtree: [],
    groupUpload: null,
    copyBackground: true,
    // 合成 RT 的采样（P8 步骤 1，p8-REPORT、rea-p8-layer §3）：图层 +0x304 的两位只由对象 JSON 写，构造时缺省 clampuvs 真、
    // nointerpolation 假；绑属性、挂脚本的由能力表照报，这里按缺省取
    clampUVs: object.clampuvs !== false,
    noInterpolation: object.nointerpolation === true,
    fullscreen: false,
    fullscreenSize: null,
    passes: [],
    colorBlendMode,
    effects: [],
    passthrough: null,
    particle: null,
    text: null,
    model: null,
    shape: null,
    camera: null,
  };
}

/** 材质路径 → 模型材质模板（`SceneBundle.modelMaterials`）的键：规整路径并转小写（WPE 的文件查找不分大小写）；不合法的路径返回 null。 */
export function modelMaterialKey(path: string): string | null {
  try {
    return normalizeScenePath(path).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 一个形状的网格字段（不含 `material` / `passes`）：`vertices` / `indices` 是空视图（字节在数据仓，每次新建，bundle 转移缓冲时互不牵连）。
 * 没有索引的形状（描述的 `indexFormat` 为 null）写成 `indexCount: 0`（`indexFormat` 填 `uint16` 占位）：mdl 网格的索引个数恒 > 0，
 * 所以带 `source` 且 `indexCount === 0` 就是 `draw(顶点数)`，对 mdl 网格的字段与渲染零影响。
 */
export function modelDataMeshBase(
  shape: ModelDataShapeDesc,
): Pick<SceneMesh, "format" | "stride" | "vertices" | "indices" | "vertexCount" | "indexFormat" | "indexCount"> {
  return {
    format: shape.format,
    stride: mdlStride(shape.format),
    vertices: new Uint8Array(0),
    indices: new Uint8Array(0),
    vertexCount: shape.vertexCount,
    indexFormat: shape.indexFormat ?? "uint16",
    indexCount: shape.indexFormat ? shape.indexCount : 0,
  };
}

/** 由描述与 pass 组装一个网格（字段顺序同 `compileMesh`）。 */
export function modelDataMesh(
  token: number,
  shapeIndex: number,
  shape: ModelDataShapeDesc,
  passes: ScenePass[],
  shadow?: ScenePass,
): SceneMesh {
  return {
    ...modelDataMeshBase(shape),
    material: shape.material,
    passes,
    source: { token, shape: shapeIndex },
    ...(shadow ? { shadow } : {}),
  };
}

export interface ModelDataModelOptions {
  /** 场景有阴影（`castsShadows`：档位 ≠ 0 且有点光 / 平行光 / 聚光阴影计数） */
  castsShadows: boolean;
  /** 对象 `castshadow` 经属性解析后的值（只有 `false` 关闭，缺省开） */
  castSetting: unknown;
}

/** 脚本模型数据的 `SceneModel`：没有骨骼，`path` 为空、`version` 为 0，包围盒取描述的（建时定一次）。 */
export function modelDataModel(desc: ModelDataDesc, meshes: SceneMesh[], options: ModelDataModelOptions): SceneModel {
  const opaque = meshes.map((mesh) => isOpaqueBlending(mesh.passes[0]?.blending));
  const castShadow = options.castsShadows && options.castSetting !== false && opaque.some(Boolean);
  return {
    path: "",
    version: 0,
    meshes,
    order: meshDrawOrder(opaque),
    bounds: [...desc.bounds],
    ...(castShadow ? { castShadow } : {}),
  };
}

/** 透明排序的类别（同 mdl 模型对象）：任一网格不透明为 `opaque`，否则 `translucent`（没有网格也是半透明）。 */
export function modelDataSortClass(meshes: readonly SceneMesh[]): SortClass {
  return meshes.some((mesh) => isOpaqueBlending(mesh.passes[0]?.blending)) ? "opaque" : "translucent";
}
