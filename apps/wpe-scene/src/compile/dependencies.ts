/**
 * 图层依赖（P8 步骤 4，`.claude/plans/wpe-import/3-scene/phase8/phase-8-image-material.md`「步骤 4」）：编译期用到的名字、并集与占位纹理。
 *
 * WPE 的图层依赖是两件事（rea-p8-render 第 1、2 节，p8-REPORT 结论 7–9、12）：
 * - 全部对象的 `dependencies` 取并集，命中的图像层「被依赖」：合成链第 0 张换成按图层独占、跨帧保留的 RT
 *   （`_rt_imageLayerComposite_<id>_a`），不可见也照画进去（`SceneLayer.dependedOn`，渲染见 `render/graph.ts`、`render/scene.ts`）；
 * - 材质槽里写的这个名字在材质创建时按名字绑到那张 RT（`ScenePass.layerComposites`），绑不上的一直是 6×6 的黄黑棋盘格（`checkerTexture`）。
 */
import type { SceneTexture } from "./bundle";
import type { SceneObject } from "./model";

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
 * 别的元素（负数、小数、字符串、null、粒子自己那套 `{id, type, …}` 对象）跳过。不分是谁列的：模型对象列的也算（`3509243656` 的两个模型
 * 对象就给图像层置了位），重复的只算一次。
 */
export function dependencyIds(objects: readonly SceneObject[]): Set<number> {
  const ids = new Set<number>();
  for (const object of objects)
    for (const element of dependencyElements(object.dependencies))
      if (typeof element === "number" && Number.isInteger(element) && element >= 0) ids.add(element);
  return ids;
}

/**
 * `dependencies` 里有不是数字的元素（P8 步骤 4，`features.ts` 的粒子检查用）：粒子对象另有一套同名键（`FUN_14022af30`，元素是
 * `{id, type: "emitterimage" | "collisionmodel", index, mask}`），那是发射图与碰撞模型，没做。遍历规则同 `dependencyIds`。
 */
export function hasNonNumericDependency(object: SceneObject): boolean {
  return dependencyElements(object.dependencies).some((element) => typeof element !== "number");
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
