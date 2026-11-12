/**
 * 文本网格的顶点与索引（P6b 1c，给 1d 的绘制用），照 WPE `FUN_1401b0410` 建网格的写法（`0x1401b29be` 一带）：
 * 每个字形 4 个顶点、每个 20 字节（`a_Position` float3，z 恒 0 + `a_TexCoord` float2），索引 uint16
 * `4i, 4i+2, 4i+1, 4i+1, 4i+2, 4i+3`。y 向上，图集第 0 行是位图顶行，所以顶边用 `v0`。
 *
 * | 顶点 | 位置 | UV |
 * |---|---|---|
 * | 0 | `(x0, y1)` | `(u0, v0)` |
 * | 1 | `(x1, y1)` | `(u1, v0)` |
 * | 2 | `(x0, y0)` | `(u0, v1)` |
 * | 3 | `(x1, y0)` | `(u1, v1)` |
 *
 * UV 在调用时从图集字形读：图集扩容后（`GlyphAtlas.generation` 变了）重新调一次即可（WPE 也是那时重建网格）。
 */
import type { TextQuad } from "./layout";

/** 每个顶点的 float 数（位置 3 + UV 2）。 */
export const TEXT_VERTEX_FLOATS = 5;

/** 一组字形四边形的顶点（`4 · 5` 个 float / 字形）。 */
export function textVertices(quads: readonly TextQuad[]): Float32Array {
  const out = new Float32Array(quads.length * 4 * TEXT_VERTEX_FLOATS);
  let o = 0;
  for (const { x0, y0, x1, y1, glyph } of quads) {
    const { u0, v0, u1, v1 } = glyph;
    out.set([x0, y1, 0, u0, v0, x1, y1, 0, u1, v0, x0, y0, 0, u0, v1, x1, y0, 0, u1, v1], o);
    o += 4 * TEXT_VERTEX_FLOATS;
  }
  return out;
}

/** `count` 个字形的索引（WPE 用 uint16，一个网格最多 16384 个字形）。 */
export function textIndices(count: number): Uint16Array {
  const out = new Uint16Array(count * 6);
  for (let i = 0; i < count; i++) {
    const v = 4 * i;
    out.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], 6 * i);
  }
  return out;
}
