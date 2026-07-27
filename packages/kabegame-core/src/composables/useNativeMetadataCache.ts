import { invoke } from "../api";
import { nativeMetadataCacheDb } from "../cache/nativeMetadataCache";
import { IS_WEB } from "../env";
import {
  NATIVE_METADATA_CACHE_VERSION,
  type NativeMetadataPayload,
} from "../types/nativeMetadata";

const MAX_CACHE_SIZE = 256;

function cacheKeyFor(imageId: string): string {
  return `${imageId}@nv${NATIVE_METADATA_CACHE_VERSION}`;
}

class LruMap {
  private readonly map = new Map<string, NativeMetadataPayload>();

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): NativeMetadataPayload | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** 写入并返回被淘汰的 key（无淘汰返回 null） */
  set(key: string, value: NativeMetadataPayload): string | null {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > MAX_CACHE_SIZE) {
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
      return oldest;
    }
    return null;
  }

  /** 初始化时从 Dexie 批量载入，不触发淘汰逻辑 */
  load(key: string, value: NativeMetadataPayload): void {
    this.map.set(key, value);
  }
}

const mem = new LruMap();

/** 启动时从 Dexie 初始化内存 LRU，保证两者同步；只执行一次 */
let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!IS_WEB) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = nativeMetadataCacheDb.entries
    .orderBy("cachedAt")
    .limit(MAX_CACHE_SIZE)
    .toArray()
    .then((all) => {
      for (const { cacheKey, data } of all) {
        mem.load(cacheKey, data);
      }
    })
    .catch(() => {});
  return initPromise;
}

/**
 * 解析图片原生元数据。成功结果（包括 null）进入全局 LRU；
 * Web 模式额外持久化到 IndexedDB，错误保持抛出且不缓存。
 */
export async function resolveNativeMetadata(
  imageId: string,
): Promise<NativeMetadataPayload> {
  await ensureInit();

  const key = cacheKeyFor(imageId);
  if (mem.has(key)) {
    return mem.get(key) ?? null;
  }

  const data = await invoke<NativeMetadataPayload>("get_image_native_metadata", {
    imageId,
  });
  const value = data ?? null;
  const evictedKey = mem.set(key, value);

  if (IS_WEB) {
    if (evictedKey) {
      // 原子事务：删除被淘汰条目并写入新条目，Dexie 始终不超过容量。
      void nativeMetadataCacheDb.transaction(
        "rw",
        nativeMetadataCacheDb.entries,
        async () => {
          await nativeMetadataCacheDb.entries.delete(evictedKey);
          await nativeMetadataCacheDb.entries.put({
            cacheKey: key,
            data: value,
            cachedAt: Date.now(),
          });
        },
      );
    } else {
      void nativeMetadataCacheDb.entries.put({
        cacheKey: key,
        data: value,
        cachedAt: Date.now(),
      });
    }
  }

  return value;
}
