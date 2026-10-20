import Dexie, { type Table } from "dexie";

export interface CachedStorePluginIcon {
  key: string; // `${sourceId}:${pluginId}`
  version: string;
  iconBase64: string;
  cachedAt: number;
}

class StorePluginCacheDb extends Dexie {
  icons!: Table<CachedStorePluginIcon, string>;

  constructor() {
    super("kbg-store-plugin-cache");
    this.version(1).stores({
      icons: "key",
      details: "key",
    });
    this.version(2).stores({ icons: "key", details: null });
  }
}

export const storePluginCacheDb = new StorePluginCacheDb();
