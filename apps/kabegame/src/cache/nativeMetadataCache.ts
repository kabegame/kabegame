import Dexie, { type Table } from "dexie";
import type { NativeMetadataPayload } from "../types/nativeMetadata";

export interface CachedNativeMetadata {
  /** imageId + native metadata parser version */
  cacheKey: string;
  data: NativeMetadataPayload;
  cachedAt: number;
}

class NativeMetadataCacheDb extends Dexie {
  entries!: Table<CachedNativeMetadata, string>;

  constructor() {
    super("kbg-native-metadata-cache");
    this.version(1).stores({ entries: "cacheKey, cachedAt" });
  }
}

export const nativeMetadataCacheDb = new NativeMetadataCacheDb();
