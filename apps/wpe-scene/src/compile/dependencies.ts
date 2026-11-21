/**
 * 图层依赖（P8 步骤 4，`.claude/plans/wpe-import/3-scene/phase8/phase-8-image-material.md`「步骤 4」）：编译期用到的名字、并集与占位纹理。
 *
 * WPE 的图层依赖是两件事（rea-p8-render 第 1、2 节，p8-REPORT 结论 7–9、12）：
 * - 全部对象的 `dependencies` 取并集，命中的图像层「被依赖」：合成链第 0 张换成按图层独占、跨帧保留的 RT
 *   （`_rt_imageLayerComposite_<id>_a`），不可见也照画进去（`SceneLayer.dependedOn`，渲染见 `render/graph.ts`、`render/scene.ts`）；
 * - 材质槽里写的这个名字在材质创建时按名字绑到那张 RT（`ScenePass.layerComposites`），绑不上的一直是 6×6 的黄黑棋盘格（`checkerTexture`）。
 */
import type { SceneTexture } from "./bundle";
import { objectKind } from "./features";
import { isSceneObject, type SceneObject } from "./model";

/** 合成 RT 的名字前缀（rea-p8-render 2.1，字符串 `0x1404906f8`）。 */
export const LAYER_COMPOSITE_PREFIX = "_rt_imageLayerComposite_";

/**
 * 被依赖图层独占 RT 的名字（rea-p8-render 2.1、2.2，`ea500_name_1401ea720.asm`）：前缀、id 按十进制（`FUN_140153110`）、`_`、后缀写死
 * `a`（后缀字符串 `0x140490714` 全文件只有这一处引用）。`_b` 不存在：只有第 0 张、只在 `0x10` 时起名。
 */
export function layerCompositeName(id: number): string {
  return `${LAYER_COMPOSITE_PREFIX}${id}_a`;
}

/** `dependencies` 的元素：值是数组（jsoncpp 6）或对象（7，取值）才遍历，其它类型等于没写（rea-p8-render 1.1，`0x1401dde17`–`0x1401dde29`）。 */
function dependencyElements(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

/**
 * 全部对象 `dependencies` 的并集（rea-p8-render 第 1 节：对象基类构造 `FUN_1401ddbb0` 读、场景构造 `FUN_140186c90` 的依赖段
 * `0x140187f93`–`0x140188084` 取并集）：元素是非负整数才收（`FUN_140088800` 能否转成整数、`FUN_140086000` 取成 64 位无符号整数），
 * 别的元素（负数、小数、字符串、null）跳过。不分是谁列的：模型对象列的也算（`3509243656` 的两个模型
 * 对象就给图像层置了位），重复的只算一次。
 *
 * 粒子对象（P4j 步骤 1，rea-p4j-layerimage.md 1.4 第 8 条）另有一套同名键：元素是 `{id, type, index, mask}` 对象，过三道门的
 * （`particleDependencies`）`id` 也进并集，两种类型都进、`id 0` 也进。这更正了 P8 的「对象元素不进集合」：被发射图引用的图层和数字依赖一样
 * 「被依赖」，步骤 2 要读的合成 RT 由此存在。
 */
export function dependencyIds(objects: readonly SceneObject[]): Set<number> {
  const ids = new Set<number>();
  for (const object of objects) {
    if (!isSceneObject(object)) continue;
    for (const element of dependencyElements(object.dependencies))
      if (typeof element === "number" && Number.isInteger(element) && element >= 0) ids.add(element);
    // 判定与 `features.ts` 的 `objectKind(object) === "particle"` 一致
    if (objectKind(object) === "particle")
      for (const dependency of particleDependencies(object)) ids.add(dependency.id);
  }
  return ids;
}

/** 粒子对象 `dependencies` 的一项（rea-p4j-layerimage.md 1.4，`FUN_14022af30`）。 */
export interface ParticleDependency {
  /** 1 发射图（`emitterimage`）、3 碰撞模型（`collisionmodel`）。 */
  type: 1 | 3;
  id: number;
  /** u32；本系统同类型槽的序号（1.5）。 */
  index: number;
  /** 纹理路径；不是字符串时为空串。 */
  mask: string;
  /** `id != 0`：0 进集合但永远绑不上。 */
  valid: boolean;
}

/**
 * 粒子对象的依赖（1.4）：元素是对象（非数组）才读；三道门 `id` 非负整数（< 2⁶⁴）、`index` 是 [0, 2³²) 的整数（缺了不过）、
 * `type` 是字符串；`type` 只认 "emitterimage" / "collisionmodel"（大小写敏感），其余跳过。JSON 顺序。
 * 不是对象的元素（数字等）WPE 这里怎么处理没读到【推：jsoncpp 的 operator[] 对非对象断言】，跳过；数字元素照旧进并集。
 */
export function particleDependencies(object: SceneObject): ParticleDependency[] {
  const result: ParticleDependency[] = [];
  for (const element of dependencyElements(object.dependencies)) {
    if (!isSceneObject(element)) continue;
    const { id, index, type, mask } = element as Record<string, unknown>;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id >= 2 ** 64) continue;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= 2 ** 32) continue;
    if (typeof type !== "string") continue;
    const kind = type === "emitterimage" ? 1 : type === "collisionmodel" ? 3 : null;
    if (kind === null) continue;
    result.push({ type: kind, id, index, mask: typeof mask === "string" ? mask : "", valid: id !== 0 });
  }
  return result;
}

/**
 * 一个系统里每个 `layerimage` 发射器配到的依赖（1.5）：第 k 个 `layerimage`（只数 `layerimage`，别的发射器不占序号）配
 * `type 1`、`valid`、`index === k` 的最后一条（后面的覆盖前面的），没有为 null。结果按 `layerimage` 发射器的先后，每个一项。
 * 子系统与事件实例用同一个对象的列表，调用方对每个系统各调一次（序号从 0 数）。
 */
export function bindLayerImages(
  emitters: readonly { name: string }[],
  dependencies: readonly ParticleDependency[],
): ({ id: number; mask: string } | null)[] {
  const bound: ({ id: number; mask: string } | null)[] = [];
  let slot = 0;
  for (const emitter of emitters) {
    if (emitter.name !== "layerimage") continue;
    const k = slot++;
    const matches = dependencies.filter(
      (dependency) => dependency.type === 1 && dependency.valid && dependency.index === k,
    );
    const last = matches[matches.length - 1];
    bound.push(last ? { id: last.id, mask: last.mask } : null);
  }
  return bound;
}

/** 棋盘格的边长（`texload_fallback_1400ec330.asm` 的 `edi = 6`）。 */
const CHECKER_SIZE = 6;

/**
 * 引用不到时的占位纹理（rea-p8-render 2.6，p8-REPORT 结论 12、`p8-dep` 的 4–6 逐格读到黑黄交替、第一格黑）：WPE 按名字新建文件纹理、
 * 找不到文件时退回的那张（`FUN_1400ec220` 的退回分支 `0x1400ec509`、像素 `FUN_140170510`）。
 * - 6×6 RGBA8（格式 0），一级 mip，图像尺寸与纹理尺寸都是 6；
 * - 第 i 个像素行 = i / 6（整除），`(行 & 1) != (i & 1)` 时 (255, 255, 0, 255) 黄、否则 (0, 0, 0, 255) 黑：(0, 0) 黑、(1, 0) 黄、
 *   (0, 1) 黄；
 * - 标志 9（bit0 点采样 + bit3），采样器实测 Wrap / Point（`p8-dep` 的 4）：`clampUVs` 假、`noInterpolation` 真。bit3 我们的表里叫
 *   `clampBorder`（`parseTex` 照报），这里不经 `parseTex`，采样器只看那两个字段，和实测一致。
 * `path` 不是任何真文件的路径（`getTexture` 给的都以 `materials/` 开头，尖括号也不可能出现在文件名里），只进标签与报错；`source` 同理。
 * 不进 `getTexture` 的缓存（按真文件路径）。每次调用新建一份像素：bundle 交给主线程时会转移 mip 的缓冲（`transferableBuffers`），
 * 共用一份会在下一次编译时读到已分离的缓冲。
 */
export function checkerTexture(): SceneTexture {
  const bytes = new Uint8Array(CHECKER_SIZE * CHECKER_SIZE * 4);
  for (let i = 0; i < CHECKER_SIZE * CHECKER_SIZE; i++) {
    const row = Math.floor(i / CHECKER_SIZE);
    const v = (row & 1) !== (i & 1) ? 255 : 0;
    bytes.set([v, v, 0, 255], i * 4);
  }
  return {
    path: "<checker>",
    source: "placeholder",
    format: 0,
    width: CHECKER_SIZE,
    height: CHECKER_SIZE,
    textureWidth: CHECKER_SIZE,
    textureHeight: CHECKER_SIZE,
    flags: 9,
    clampUVs: false,
    noInterpolation: true,
    mips: [{ width: CHECKER_SIZE, height: CHECKER_SIZE, bytes }],
  };
}
