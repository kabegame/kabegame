import Dexie, { type Table } from "dexie";

export interface CachedImageMetadata {
  /** metadataId（字符串化）优先，否则为 imageId */
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
  }
}

export const imageMetadataCacheDb = new ImageMetadataCacheDb();
