import Dexie, { type Table } from "dexie";

export interface CachedImageMetadata {
  imageId: string;
  data: unknown | null;
  cachedAt: number;
}

class ImageMetadataCacheDb extends Dexie {
  entries!: Table<CachedImageMetadata, string>;

  constructor() {
    super("kbg-image-metadata-cache");
    this.version(1).stores({ entries: "imageId, cachedAt" });
  }
}

export const imageMetadataCacheDb = new ImageMetadataCacheDb();
