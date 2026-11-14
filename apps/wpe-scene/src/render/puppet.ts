/**
 * puppet 网格的 GPU 侧辅助（P12a 步骤 4，rea-p12-mdl 9.2、9.6）：纯函数，不碰 GPU，`scene.ts` 照它建顶点缓冲与写 `g_Bones`，单测直接核对。
 */
import { meshAttributes } from "../compile/mdl";
import type { ScenePuppet } from "../compile/puppet";
import { alignedBytes } from "./mesh";

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

/** 这个 puppet 直接上屏时是否需要私有的顶点缓冲（`a_TexCoord` 要乘 `uv`）。 */
export function needsScaledVertices(mesh: Pick<ScenePuppet["mesh"], "format">, uv: readonly [number, number]): boolean {
  return (
    (uv[0] !== 1 || uv[1] !== 1) && meshAttributes(mesh.format).some((attribute) => attribute.name === "a_TexCoord")
  );
}
