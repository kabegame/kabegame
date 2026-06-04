import Dexie, { type Table } from "dexie";

export interface CachedImageMetadata {
  /** imageId + metadataVersion */
  cacheKey: string;
  data: unknown | null;
  cachedAt: number;
}

class ImageMetadataCacheDb extends Dexie {
  entries!: Table<CachedImageMetadata, string>;

  constructor() {
    super("kbg-image-metadata-cache");
    this.version(1).stores({ entries: "imageId, cachedAt" });
    // v2: 主键改为 cacheKey（metadataId 优先），旧缓存作废、按需重建
    this.version(2).stores({ entries: "cacheKey, cachedAt" });
    // v3: metadata 只能按 imageId 读取，清空旧的 metadataId-keyed 缓存避免数字 key 撞到图片 id。
    this.version(3)
      .stores({ entries: "cacheKey, cachedAt" })
      .upgrade((tx) => tx.table("entries").clear());
    // v4: cacheKey 纳入 metadataVersion，旧 imageId-only 缓存作废。
    this.version(4)
      .stores({ entries: "cacheKey, cachedAt" })
      .upgrade((tx) => tx.table("entries").clear());
  }
}

export const imageMetadataCacheDb = new ImageMetadataCacheDb();
