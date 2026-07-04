import Dexie, { type Table } from "dexie";
import type { Plugin } from "../stores/plugins";

export interface CachedStorePluginIcon {
  key: string;       // `${sourceId}:${pluginId}`
  version: string;
  iconBase64: string;
  cachedAt: number;
}

export interface CachedStorePluginDetail {
  key: string;       // `${sourceId}:${pluginId}`
  version: string;
  data: Plugin;
  cachedAt: number;
}

class StorePluginCacheDb extends Dexie {
  icons!: Table<CachedStorePluginIcon, string>;
  details!: Table<CachedStorePluginDetail, string>;

  constructor() {
    super("kbg-store-plugin-cache");
    this.version(1).stores({
      icons: "key",
      details: "key",
    });
  }
}

export const storePluginCacheDb = new StorePluginCacheDb();
