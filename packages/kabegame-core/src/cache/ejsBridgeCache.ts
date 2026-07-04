import Dexie, { type Table } from "dexie";

export interface CachedEjsBridgeEntry {
  cacheKey: string;
  data: unknown;
  cachedAt: number;
}

class EjsBridgeCacheDb extends Dexie {
  entries!: Table<CachedEjsBridgeEntry, string>;

  constructor() {
    super("kbg-ejs-bridge-cache");
    this.version(1).stores({ entries: "cacheKey, cachedAt" });
  }
}

const MAX_CACHE_SIZE = 256;

class LruMap {
  private readonly map = new Map<string, unknown>();

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): unknown | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: unknown): string | null {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > MAX_CACHE_SIZE) {
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
      return oldest;
    }
    return null;
  }

  load(key: string, value: unknown): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
  }
}

const db = new EjsBridgeCacheDb();
const mem = new LruMap();
let initPromise: Promise<void> | null = null;

function scopedKey(pluginId: string, key: string): string {
  return `${pluginId}:${key}`;
}

function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = db.entries
    .orderBy("cachedAt")
    .reverse()
    .limit(MAX_CACHE_SIZE)
    .toArray()
    .then((recent) => {
      for (const entry of recent.reverse()) {
        mem.load(entry.cacheKey, entry.data);
      }
    })
    .catch(() => {});
  return initPromise;
}

export async function getEjsBridgeCache(
  pluginId: string,
  key: string,
): Promise<unknown | null> {
  await ensureInit();
  const cacheKey = scopedKey(pluginId, key);
  if (mem.has(cacheKey)) {
    return mem.get(cacheKey) ?? null;
  }
  try {
    const entry = await db.entries.get(cacheKey);
    if (!entry) return null;
    mem.set(cacheKey, entry.data);
    return entry.data ?? null;
  } catch {
    return null;
  }
}

export async function setEjsBridgeCache(
  pluginId: string,
  key: string,
  data: unknown,
): Promise<void> {
  await ensureInit();
  const cacheKey = scopedKey(pluginId, key);
  const evictedKey = mem.set(cacheKey, data);
  try {
    if (evictedKey) {
      await db.transaction("rw", db.entries, async () => {
        await db.entries.delete(evictedKey);
        await db.entries.put({ cacheKey, data, cachedAt: Date.now() });
      });
    } else {
      await db.entries.put({ cacheKey, data, cachedAt: Date.now() });
    }
  } catch {
    // Memory cache still serves this session if IndexedDB is unavailable.
  }
}
