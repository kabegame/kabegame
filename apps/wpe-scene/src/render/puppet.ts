/**
 * puppet 网格的 GPU 侧辅助（P12a 步骤 4，rea-p12-mdl 9.2、9.6）：纯函数，不碰 GPU，`scene.ts` 照它建顶点缓冲与写 `g_Bones`，单测直接核对。
 */
import { meshAttributes } from "../compile/mdl";
import type { PuppetClipping, ScenePuppet } from "../compile/puppet";
import type { ScenePuppets } from "../puppet/player";
import { alignedBytes } from "./mesh";

/**
 * 渲染器要的 puppet 运行时（`GpuScene.setPuppets`、`SceneRenderer.load` 的 `puppets`）：蒙皮矩阵必须有，挂点的模型空间姿势、骨骼透明度、变形上传值
 * （P12b1）可以没有（手写的假来源、旧的调用方）：没有姿势时挂点按普通父子，没有透明度时全 1，没有变形时不变形。
 */
export type PuppetSource = Pick<ScenePuppets, "skin"> &
  Partial<Pick<ScenePuppets, "pose" | "boneAlpha" | "morph" | "bounds" | "blendMap" | "drawOrder">>;

/**
 * 直接上屏的 puppet 顶点（rea-p12-mdl 9.2 `FUN_14020ae00`）：WPE 拷一份网格 0 的顶点字节，把每个顶点的 `a_TexCoord`（表序 7，只有这一项，
 * `a_TexCoordVec3` / `Vec4` 与别的 UV 不动）乘 `(uScale, vScale)` = 图像 / GPU 纹理（`step.uv`），位置与别的属性原样，不内缩。
 * 乘法是 float32（`Math.fround`，`DataView.setFloat32` 自带舍入，两个 float32 的乘积在 float64 里是精确的）。`uv` 为 (1, 1) 或没有 `a_TexCoord`
 * 时原样返回 mdl 视图（调用方按视图共用缓冲，不拷贝）。返回的长度已补到 4 的倍数（`writeBuffer` 的要求）。
 */
export function scaledPuppetVertices(
  mesh: Pick<ScenePuppet["mesh"], "format" | "stride" | "vertices" | "vertexCount">,
  uv: readonly [number, number],
): Uint8Array {
  const item = meshAttributes(mesh.format).find((attribute) => attribute.name === "a_TexCoord");
  if (!item || (uv[0] === 1 && uv[1] === 1)) return alignedBytes(mesh.vertices);
  const bytes = new Uint8Array(Math.max(4, Math.ceil(mesh.vertices.byteLength / 4) * 4));
  bytes.set(mesh.vertices);
  const view = new DataView(bytes.buffer);
  const count = Math.min(mesh.vertexCount, Math.floor(mesh.vertices.byteLength / mesh.stride));
  for (let i = 0; i < count; i++) {
    const at = i * mesh.stride + item.offset;
    view.setFloat32(at, view.getFloat32(at, true) * uv[0], true);
    view.setFloat32(at + 4, view.getFloat32(at + 4, true) * uv[1], true);
  }
  return bytes;
}

/** 变形纹理的表键（`GpuScene.morphTargets`）：图像层 puppet 一张（`"<对象>"`），模型每个有变形目标的网格一张（`"<对象>:<网格>"`，P12b2-1）。 */
export function morphKey(object: number, mesh?: number): string {
  return mesh === undefined ? `${object}` : `${object}:${mesh}`;
}

/** 这个 puppet 直接上屏时是否需要私有的顶点缓冲（`a_TexCoord` 要乘 `uv`）。 */
export function needsScaledVertices(mesh: Pick<ScenePuppet["mesh"], "format">, uv: readonly [number, number]): boolean {
  return (
    (uv[0] !== 1 || uv[1] !== 1) && meshAttributes(mesh.format).some((attribute) => attribute.name === "a_TexCoord")
  );
}

/**
 * 变形纹理的上传数据（P12b1 步骤 4）：一律 `rgba32float`，值是 D3D snorm 的解码 `max(c / 32767, −1)`（float32，−32768 与 −32767 都是 −1）。
 * 不用 WPE 的 `rgba16snorm`：rgba16snorm 在 Dawn 上只能当 unfilterable-float 采样，而翻译出的着色器是 textureSampleLevel + 普通 sampler，auto layout 要 filterable float，绑不上；WPE 是 rgba16snorm，snorm → float 的换算是 c / 32767，结果相同。设备要有 `float32-filterable`，没有时报 `render:morph-texture`。
 */
export function morphTexelData(texels: Int16Array): Float32Array {
  const out = new Float32Array(texels.length);
  for (let i = 0; i < texels.length; i++) out[i] = Math.fround(Math.max(texels[i] / 32767, -1));
  return out;
}

/** 裁切遮罩 RT 的尺寸（P12b1 步骤 5，rea-p12b 第 2 节）：场景目标宽、高各整除 2、至少 2（WPE 是后备缓冲的一半，`_rt_FullAlphaMask`）。 */
export function clipMaskSize(width: number, height: number): [number, number] {
  return [Math.max(2, Math.floor(width / 2)), Math.max(2, Math.floor(height / 2))];
}

/** 没有这一段（模板用不到）：`count = 0`，编码时整次跳过。 */
const NO_SEGMENT = new Uint16Array(0);

/**
 * 有裁切的 puppet 一帧要写进各个模板索引缓冲的段（P12f 点 5）：`normals[k]` 是命令表里第 k 个普通命令的段，`masks[r]` / `targets[r]` 是第 r 条记录的
 * 遮罩段与目标段；命令表里没有出现的槽位 / 记录给空数组（`count = 0`）。槽位数与记录数由计划定（`planLayer`：普通段 记录数 + 1 个），命令表多出来的
 * 命令（合法的表不会有）忽略。纯函数。
 */
export function clipTemplateSegments(
  clipping: Pick<PuppetClipping, "commands" | "segments">,
  normalSlots: number,
  recordCount: number,
): { normals: Uint16Array[]; masks: Uint16Array[]; targets: Uint16Array[] } {
  const normals: Uint16Array[] = Array.from({ length: normalSlots }, () => NO_SEGMENT);
  const masks: Uint16Array[] = Array.from({ length: recordCount }, () => NO_SEGMENT);
  const targets: Uint16Array[] = Array.from({ length: recordCount }, () => NO_SEGMENT);
  let slot = 0;
  for (const command of clipping.commands) {
    if (command.kind === "normal") {
      if (slot < normalSlots) normals[slot] = clipping.segments[command.segment] ?? NO_SEGMENT;
      slot++;
    } else if (command.record < recordCount) {
      masks[command.record] = clipping.segments[command.mask] ?? NO_SEGMENT;
      targets[command.record] = clipping.segments[command.target] ?? NO_SEGMENT;
    }
  }
  return { normals, masks, targets };
}

/** `puppet-clip` op 编码时的一步：普通段 `index` 是槽位；清遮罩 RT / 遮罩段 / 目标段的 `index` 是记录号。 */
export interface ClipDrawPart {
  part: "normal" | "clear" | "mask" | "target";
  index: number;
}

/**
 * 当前命令表的绘制序列（P12f 点 5）：第 j 个普通命令画 `normals[j]`；记录 r 的命令先清遮罩 RT、再画 `masks[r]`、再画 `targets[r]`。
 * 超出槽位数 / 记录数的命令跳过（同 `clipTemplateSegments`）。编码与平面反射 pass 共用这一个序列。纯函数。
 */
export function clipDrawSequence(
  commands: PuppetClipping["commands"],
  normalSlots: number,
  recordCount: number,
): ClipDrawPart[] {
  const out: ClipDrawPart[] = [];
  let slot = 0;
  for (const command of commands) {
    if (command.kind === "normal") {
      if (slot < normalSlots) out.push({ part: "normal", index: slot });
      slot++;
    } else if (command.record < recordCount) {
      out.push({ part: "clear", index: command.record });
      out.push({ part: "mask", index: command.record });
      out.push({ part: "target", index: command.record });
    }
  }
  return out;
}

/** 模板索引缓冲的容量：网格总索引数 × 2 字节，补到 4 的倍数、至少 4（P12f 点 5；一段不会比整张网格长）。 */
export function puppetIndexCapacity(indexCount: number): number {
  return Math.max(4, Math.ceil((indexCount * 2) / 4) * 4);
}

/**
 * 一段索引上传的字节与 `count`（P12f 点 5）：补到 4 的倍数（`writeBuffer` 的要求，u16 个数为奇数时多一个 0，不进 `count`），超出容量的部分截掉
 * （合法的 mdl 不会超；超了不让 WebGPU 校验错误丢掉整帧）。
 */
export function indexUpload(indices: Uint16Array, capacityBytes: number): { bytes: Uint8Array; count: number } {
  const count = Math.min(indices.length, Math.floor(capacityBytes / 2));
  const bytes = new Uint8Array(Math.max(4, Math.ceil((count * 2) / 4) * 4));
  new Uint16Array(bytes.buffer, 0, count).set(indices.subarray(0, count));
  return { bytes, count };
}
