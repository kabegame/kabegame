import Dexie, { type Table } from "dexie";
import type { Plugin } from "../stores/plugins";

export interface CachedPlugin {
  id: string;
  version: string;
  data: Plugin;
  cachedAt: number;
}

class PluginCacheDb extends Dexie {
  plugins!: Table<CachedPlugin, string>;

  constructor() {
    super("kbg-plugin-cache");
    this.version(1).stores({ plugins: "id" });
  }
}

export const pluginCacheDb = new PluginCacheDb();
