/**
 * 模型网格的绘制（P5c 步骤 2，`.claude/plans/wpe-import/3-scene/phase5/phase-5c-mesh.md`「步骤 2」）：按 mdl 的顶点格式建 WebGPU 顶点布局、
 * 上传前的 4 字节补齐、视锥剔除。纯函数，不碰 GPU；`scene.ts` 照它建缓冲与管线、每帧判剔除。依据是 p5-REPORT「P5c 语义的实测核对」
 * 与 rea-p5-mesh 第 1、3、4 节。
 */
import { attributeSemantic, attributeTypeMatches, mdlStride, meshAttributes, semanticKey } from "../compile/mdl";
import type { MdlVertexAttribute } from "../compile/mdl";
import type { InterfaceVariable } from "../wpesl2wgsl";
import { transformPoint, type Mat4 } from "./math";
import { attributeColumns } from "./programs";

/** 占位属性在占位缓冲里的间隔（字节）：每个占一格 16 字节（最宽的 `vec4` / `uvec4`）。 */
const PLACEHOLDER_STRIDE = 16;
/** 占位属性最多几个：WebGPU 的 `maxVertexAttributes` 缺省 16，再多建管线本来就会失败。 */
const PLACEHOLDER_SLOTS = 16;
/** 全场一份的占位顶点缓冲的字节数（全零，`scene.ts` 第一次用到时建）。 */
export const MESH_PLACEHOLDER_BYTES = PLACEHOLDER_STRIDE * PLACEHOLDER_SLOTS;

export interface MeshVertexLayout {
  /**
   * 槽 0 是网格的顶点缓冲（`arrayStride` 取 mdl 的 stride）；有占位属性时槽 1 是全零的占位缓冲（`arrayStride` 0，每个顶点读到同一份 0）。
   */
  buffers: GPUVertexBufferLayout[];
  /**
   * 布局键（`PipelineSpec.mesh`）：stride 加每个属性的 `location@偏移:格式`，占位属性另起一段。管线键里已经有程序，同一个程序下键相同
   * 布局就相同。
   */
  key: string;
  /** 占位属性的个数；0 时不绑槽 1。 */
  placeholders: number;
  /** 渲染器画不了的项（`planProblems` 的自查）。 */
  problems: string[];
}

/** 网格数据在 WebGPU 里的顶点格式：按数据的宽度（`a_BlendIndices` 是 `uint32x4`，其余 `float32xN`）。 */
function meshFormat(item: Pick<MdlVertexAttribute, "type" | "components">): GPUVertexFormat {
  const scalar = item.type === "uint" ? "uint32" : "float32";
  return (item.components > 1 ? `${scalar}x${item.components}` : scalar) as GPUVertexFormat;
}

/**
 * 按网格格式建顶点布局（p5-REPORT「P5c 语义的实测核对」的顶点布局三行）：偏移按 mdl 的表序（`meshAttributes`，`p5c-layout` 实测逐项
 * 相同），程序的每个属性按名字查语义（`attributeSemantic`），再在网格格式里找同一语义的那一项，偏移与格式照它（宽度按数据），
 * `shaderLocation` 照程序。同语义不同宽度（`a_TexCoord` 与 `a_TexCoordVec4` 都是 TEXCOORD0）由 WebGPU 截断或补 (0, 0, 0, 1)，和 WPE
 * 相同（`p5c-attr` 的 M1、M4）。
 *
 * 网格里没有数据的属性接到占位缓冲（全零，按着色器自己的类型取格式，矩阵 / 数组按列展开）：
 * - 声明了、没读（`unused`）：WPE 的 fxc 把它从输入签名里去掉，正常画（M3）；翻译器的 WGSL 入口仍带这个 location，WebGPU 建管线要有。
 * - 读了：WPE 建不出输入布局、画出未定义的值（M2、M5），编译期已报 `mdl:missing-attribute` / `mdl:attribute`，正常不会到这里；强制渲染时
 *   读到 0。
 * 网格有这一项、分量类型却对不上（`attributeTypeMatches`）：没读的同上接占位；读了的画不了，进 `problems`（编译期报
 * `mdl:attribute-type`），WebGPU 的格式与着色器类型的基础类型不同是管线校验错误。
 */
export function meshVertexLayout(attributes: readonly InterfaceVariable[], format: number): MeshVertexLayout {
  const items = new Map(meshAttributes(format).map((item) => [semanticKey(item), item]));
  const mesh: GPUVertexAttribute[] = [];
  const zeros: GPUVertexAttribute[] = [];
  const problems: string[] = [];
  for (const attribute of attributes) {
    const slots = attributeColumns(attribute);
    if (!slots) {
      problems.push(`render:attribute:${attribute.name}:${attribute.type}`);
      continue;
    }
    const semantic = attributeSemantic(attribute.name);
    const item = semantic === undefined ? undefined : items.get(semantic);
    if (item && slots.columns === 1 && attributeTypeMatches(attribute.type, item)) {
      mesh.push({ shaderLocation: attribute.location, offset: item.offset, format: meshFormat(item) });
      continue;
    }
    if (item && !attribute.unused) {
      problems.push(`render:mesh-attribute-type:${attribute.name}`);
      continue;
    }
    for (let column = 0; column < slots.columns; column++)
      zeros.push({
        shaderLocation: attribute.location + column,
        offset: zeros.length * PLACEHOLDER_STRIDE,
        format: slots.info.format,
      });
  }
  if (zeros.length > PLACEHOLDER_SLOTS) problems.push(`render:mesh-placeholders:${zeros.length}`);
  const stride = mdlStride(format);
  const describe = (list: readonly GPUVertexAttribute[]) =>
    list.map((item) => `${item.shaderLocation}@${item.offset}:${item.format}`).join(",");
  return {
    buffers: [
      { arrayStride: stride, stepMode: "vertex", attributes: mesh },
      ...(zeros.length ? [{ arrayStride: 0, stepMode: "vertex" as const, attributes: zeros }] : []),
    ],
    key: `${stride}:${describe(mesh)}${zeros.length ? `|0:${describe(zeros)}` : ""}`,
    placeholders: zeros.length,
    problems,
  };
}

/**
 * `queue.writeBuffer` 的长度要是 4 的倍数：mdl 的块不保证（u16 索引奇数个时差 2 字节），这时拷一份、末尾补 0；本来对齐的原样返回
 * （文件缓冲上的视图，不拷贝）。空块补成 4 字节（缓冲不建 0 字节的）。多出的索引不在 `indexCount` 之内，画不到。
 */
export function alignedBytes(view: Uint8Array): Uint8Array {
  const size = Math.max(4, Math.ceil(view.byteLength / 4) * 4);
  if (size === view.byteLength) return view;
  const out = new Uint8Array(size);
  out.set(view);
  return out;
}

/**
 * 视图投影的六个裁剪平面 `(a, b, c, d)`（列主序矩阵的行组合，WebGPU / D3D 的深度 0…1）：左 `r3 + r0`、右 `r3 − r0`、下 `r3 + r1`、
 * 上 `r3 − r1`、近 `r2`、远 `r3 − r2`。点 p 在平面内侧时 `a·x + b·y + c·z + d ≥ 0`。没有归一化。
 */
export function frustumPlanes(viewProjection: Mat4): [number, number, number, number][] {
  type Plane = [number, number, number, number];
  const row = (r: number): Plane => [
    viewProjection[r],
    viewProjection[4 + r],
    viewProjection[8 + r],
    viewProjection[12 + r],
  ];
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
  const plus = (a: Plane, b: Plane): Plane => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
  const minus = (a: Plane, b: Plane): Plane => [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
  return [plus(r3, r0), minus(r3, r0), plus(r3, r1), minus(r3, r1), r2, minus(r3, r2)];
}

/**
 * 模型的视锥剔除（rea-p5-mesh 4.4，p5-REPORT `p5c-frustum` 的 F1–F10）：mdl 全部网格包围盒并集（`SceneModel.bounds`）的两个角经世界矩阵
 * 变换，中点为球心、两点距离的一半为半径（只变换两个角，不是八个），球完全在视图投影某个平面的外侧（到归一化平面的有向距离 < −半径）
 * 就整个模型不画。
 * - 正交场景里生效：盒子在场景外（F1）、xy 在内但 z 在 ±2000 外（F5）、在左边缘外且外接球也在外（F7）不画；外接球伸进场景的（F8 立方体、
 *   F9 扁盒）照画；扁盒（z 厚 0）的半径小，够不到的（F10）不画。
 * - v < 17 没有包围盒，并集是 ±131072（`compile/mdl.ts` 的 `unionBounds`），球大得盖住整个场景，等于不剔（F2）。
 * 平面的法向为 0（退化的投影）时跳过那一个平面，不剔。
 */
export function frustumCulled(bounds: readonly number[], world: Mat4, viewProjection: Mat4): boolean {
  const [ax, ay, az] = transformPoint(world, bounds[0], bounds[1], bounds[2]);
  const [bx, by, bz] = transformPoint(world, bounds[3], bounds[4], bounds[5]);
  const center = [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2];
  const radius = Math.hypot(bx - ax, by - ay, bz - az) / 2;
  for (const [a, b, c, d] of frustumPlanes(viewProjection)) {
    const length = Math.hypot(a, b, c);
    if (!(length > 0)) continue;
    if ((a * center[0] + b * center[1] + c * center[2] + d) / length < -radius) return true;
  }
  return false;
}
