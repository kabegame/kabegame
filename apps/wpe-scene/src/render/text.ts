/**
 * 文本层的 GPU 侧（P6b 1d）：逐字四边形的顶点与索引、字形图集纹理。绘制与矩阵见 `graph.ts` 的 `TextStep` 与 `uniforms.ts` 的
 * `textMatrices`。
 *
 * - **几何**：每个字形 4 个顶点、6 个索引，照 WPE 的布局（`text/mesh.ts`：v0 左上、v1 右上、v2 左下、v3 右下，索引
 *   `4i, 4i+2, 4i+1, 4i+1, 4i+2, 4i+3`），三角形列表。顶点按程序的布局打包（`programVertexPacking`，位置 `(x, y, 0)` + UV），所以
 *   `flat` 着色器多出的 `a_Color` 照图层四边形补 1。空格是零尺寸的四边形，照样画（WPE 的索引数 = 字形数 × 6，含空格）。
 *   背景是一个四边形 `[0, W] × [0, H]`（整数文字框，`compositeSize`），同一套顶点顺序（p6b-fx f4 事件 203 的顶点）。
 *   索引照 WPE 用 uint16（一个网格最多 16384 个字形）；更多时退到 uint32。
 * - **图集**：`GlyphAtlas` 对象一张 GPU 纹理（同一「字体 + 字号」的层共用，`TextAtlases` 按字体键给的就是同一个对象），R8 主图集
 *   `r8unorm`、彩色图集 `rgba8unorm`，线性过滤、repeat、没有 mip（rea-p6b-raster 3.2，p6b 抓帧的采样器 Wrap / Linear）。建场景时整张
 *   上传，之后 `sync` 按 `takeDirty()` 的脏区增量上传（1d 加载之后不再排版，机制给 1e）。图集扩容（尺寸、UV 都变）要重写网格，是 1e 的事：
 *   这里遇到只记一条警告、不上传。
 */
import type { AtlasRect, GlyphAtlas } from "../text/atlas";
import type { TextQuad } from "../text/layout";
import { textIndices } from "../text/mesh";
import type { QuadVertex } from "./layout";

/** 一组字形四边形 → 图层四边形的顶点（每字形 4 个，顺序同 `text/mesh.ts` 的 `textVertices`），交给程序的布局打包。 */
export function textQuadVertices(quads: readonly TextQuad[]): QuadVertex[] {
  const out: QuadVertex[] = [];
  for (const { x0, y0, x1, y1, glyph } of quads) {
    const { u0, v0, u1, v1 } = glyph;
    out.push(
      { position: [x0, y1, 0], texCoord: [u0, v0] },
      { position: [x1, y1, 0], texCoord: [u1, v0] },
      { position: [x0, y0, 0], texCoord: [u0, v1] },
      { position: [x1, y0, 0], texCoord: [u1, v1] },
    );
  }
  return out;
}

/** 背景四边形（`flat` 着色器不读 UV）：`[0, width] × [0, height]`，顶点顺序同字形。 */
export function backgroundQuadVertices([width, height]: readonly number[]): QuadVertex[] {
  const w = width ?? 0;
  const h = height ?? 0;
  return [
    { position: [0, h, 0], texCoord: [0, 0] },
    { position: [w, h, 0], texCoord: [1, 0] },
    { position: [0, 0, 0], texCoord: [0, 1] },
    { position: [w, 0, 0], texCoord: [1, 1] },
  ];
}

/** WPE 的 uint16 索引能装下的字形数（16384 × 4 = 65536 个顶点）。 */
const UINT16_GLYPHS = 16384;

/** `count` 个四边形的索引：照 WPE 用 uint16（`text/mesh.ts`），超过 16384 个字形时换 uint32（顺序相同）。 */
export function textIndexData(count: number): Uint16Array | Uint32Array {
  if (count <= UINT16_GLYPHS) return textIndices(count);
  const out = new Uint32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const v = 4 * i;
    out.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], 6 * i);
  }
  return out;
}

/** 一张图集的 GPU 纹理（与 `scene.ts` 的 `RenderTarget` 同形，绑定时同一条路径）。 */
export interface AtlasTexture {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  format: GPUTextureFormat;
  sampler: GPUSampler;
}

/** 图集纹理的采样器：线性、repeat（rea-p6b-raster 3.2；装箱把 x 或 y 为 0 的字形四周绕回清零，正是防 wrap 的写法）。 */
export const ATLAS_SAMPLER: GPUSamplerDescriptor = {
  addressModeU: "repeat",
  addressModeV: "repeat",
  magFilter: "linear",
  minFilter: "linear",
};

/**
 * 一个场景的图集纹理：`GlyphAtlas` → GPU 纹理，建场景时整张上传。`own` 交给 `GpuScene` 管理生命周期（随场景释放）。
 */
export class TextAtlasTextures {
  private readonly textures = new Map<GlyphAtlas, AtlasTexture>();

  constructor(
    private readonly device: GPUDevice,
    private readonly sampler: GPUSampler,
    private readonly own: <T extends { destroy(): void }>(resource: T) => T,
    private readonly warnings: string[],
  ) {}

  /** 图集的纹理；第一次用到时建好并整张上传（之后的脏区由 `sync` 传）。 */
  get(atlas: GlyphAtlas): AtlasTexture {
    let found = this.textures.get(atlas);
    if (found) return found;
    const format: GPUTextureFormat = atlas.bpp === 1 ? "r8unorm" : "rgba8unorm";
    const texture = this.own(
      this.device.createTexture({
        label: `text atlas ${atlas.color ? "color " : ""}#${this.textures.size}`,
        size: { width: atlas.width, height: atlas.height },
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      }),
    );
    found = {
      texture,
      view: texture.createView(),
      width: atlas.width,
      height: atlas.height,
      format,
      sampler: this.sampler,
    };
    this.textures.set(atlas, found);
    // 建好时 CPU 侧的像素就是全部内容：整张传，脏区一并取走
    atlas.takeDirty();
    this.write(atlas, found, "all");
    return found;
  }

  /** 每帧把有改动的图集增量传上去（`GpuScene.sync` 调）；1d 加载之后不再排版，一般什么都不做。 */
  sync(): void {
    for (const [atlas, target] of this.textures) {
      if (!atlas.dirty) continue;
      const dirty = atlas.takeDirty();
      if (atlas.width !== target.width || atlas.height !== target.height) {
        // 扩容后 UV 全变、网格要重写（1e 的重排一起做）；1d 加载之后不再排版，走不到这里
        this.warnings.push(`文本图集扩容到 ${atlas.width}×${atlas.height}，1d 不重建纹理：${target.texture.label}`);
        continue;
      }
      this.write(atlas, target, dirty);
    }
  }

  /** 整张或按矩形写纹理（`writeTexture` 的行距不要求 256 对齐，矩形直接从整张缓冲里按偏移取）。 */
  private write(atlas: GlyphAtlas, target: AtlasTexture, rects: AtlasRect[] | "all"): void {
    const stride = atlas.width * atlas.bpp;
    const queue = this.device.queue;
    // 图集像素是普通 ArrayBuffer（`new Uint8Array(n)`），不会是 SharedArrayBuffer
    const pixels = atlas.pixels as Uint8Array<ArrayBuffer>;
    if (rects === "all") {
      queue.writeTexture(
        { texture: target.texture },
        pixels,
        { offset: 0, bytesPerRow: stride, rowsPerImage: atlas.height },
        { width: atlas.width, height: atlas.height },
      );
      return;
    }
    for (const rect of rects) {
      const x0 = Math.max(0, rect.x0);
      const y0 = Math.max(0, rect.y0);
      const x1 = Math.min(atlas.width, rect.x1);
      const y1 = Math.min(atlas.height, rect.y1);
      if (x1 <= x0 || y1 <= y0) continue;
      queue.writeTexture(
        { texture: target.texture, origin: { x: x0, y: y0 } },
        pixels,
        { offset: (y0 * atlas.width + x0) * atlas.bpp, bytesPerRow: stride },
        { width: x1 - x0, height: y1 - y0 },
      );
    }
  }

  /** 已建的纹理个数（dev 探针与单测用）。 */
  get size(): number {
    return this.textures.size;
  }
}
