/**
 * FreeImage 形态 `.tex`（mip 是整份 PNG / JPG）的主线程解码与跨重新编译缓存。
 *
 * Worker 编译时只给出每个 mip 在磁盘上的区间（`SceneTexture.encoded`），这里按区间读、`createImageBitmap` 解码
 * （`colorSpaceConversion: "none"`、`premultiplyAlpha: "none"`），把位图填进 `mips`。改属性目前整场重新编译，
 * 缓存让这一步不再重复读取、解码 4K PNG：键是文件路径与字节区间，`WpeSceneView` 每个目标一份，换目标或卸载时 `clear()`。
 */
import type { SceneBundle } from "./bundle";
import type { SceneReader } from "./fs";

export type ImageDecoder = (bytes: Uint8Array, mime: string) => Promise<ImageBitmap>;

/** 浏览器解码：不做色彩空间转换、不预乘 alpha（与 WPE 在 sRGB 编码空间直接计算一致）。 */
export const browserDecoder: ImageDecoder = (bytes, mime) =>
  createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });

export class TextureDecodeCache {
  private readonly entries = new Map<string, Promise<ImageBitmap>>();

  constructor(
    private readonly reader: SceneReader,
    private readonly decoder: ImageDecoder = browserDecoder,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** 读区间并解码；同一区间只解码一次，失败的不留在缓存里。 */
  get(path: string, start: number, end: number, mime: string): Promise<ImageBitmap> {
    const key = `${path}|${start}|${end}`;
    let task = this.entries.get(key);
    if (!task) {
      task = this.reader.readRange(path, start, end).then((bytes) => {
        if (bytes.length !== end - start) throw new Error(`图片区间被截断：${path} ${start}-${end}`);
        return this.decoder(bytes, mime);
      });
      this.entries.set(key, task);
      task.catch(() => {
        if (this.entries.get(key) === task) this.entries.delete(key);
      });
    }
    return task;
  }

  /** 只留下 `keep` 用到的区间，其余位图关闭（换场景内容后释放内存）。 */
  retain(keep: ReadonlySet<string>): void {
    for (const [key, task] of this.entries)
      if (!keep.has(key)) {
        this.entries.delete(key);
        void task.then((bitmap) => bitmap.close()).catch(() => undefined);
      }
  }

  clear(): void {
    this.retain(new Set());
  }
}

/**
 * 把 bundle 里 FreeImage 纹理的 mip 解成位图填进 `mips`（就地修改）。解码失败抛错，由调用方按编译失败退回。
 * 之后只保留本 bundle 用到的缓存项。`unsupported` 非空（且不是强制渲染）时调用方不必调用：渲染器不会用这些纹理。
 */
export async function decodeEncodedTextures(bundle: SceneBundle, cache: TextureDecodeCache): Promise<void> {
  const used = new Set<string>();
  await Promise.all(
    bundle.textures.map(async (texture) => {
      const encoded = texture.encoded;
      if (!encoded || texture.mips.length) return;
      const bitmaps = await Promise.all(
        encoded.mips.map((mip) => {
          used.add(`${encoded.path}|${mip.start}|${mip.end}`);
          return cache.get(encoded.path, mip.start, mip.end, encoded.mime);
        }),
      );
      texture.mips = bitmaps.map((bitmap) => ({ width: bitmap.width, height: bitmap.height, bitmap }));
    }),
  );
  cache.retain(used);
}
