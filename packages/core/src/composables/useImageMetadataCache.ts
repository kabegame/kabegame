import { provide, type InjectionKey } from "vue";
import { invoke } from "../api";
import { IS_WEB } from "../env";
import { imageMetadataCacheDb } from "../cache/imageMetadataCache";

/** 按 imageId / metadataId 解析插件 metadata（全局 LRU + IndexedDB 缓存，最多 1024 条） */
export type ImageMetadataResolver = (
  imageId: string,
  metadataId?: number,
) => Promise<unknown | null>;

export const imageMetadataResolverKey: InjectionKey<ImageMetadataResolver> =
  Symbol("imageMetadataResolver");

const MAX_CACHE_SIZE = 1024;

/** metadataId 存在时用其字符串作 key，否则降级为 imageId */
function cacheKeyFor(imageId: string, metadataId?: number): string {
  return metadataId != null ? String(metadataId) : imageId;
}

class LruMap {
  private readonly map = new Map<string, unknown | null>();

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): unknown | null | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  /** 写入并返回被淘汰的 key（无淘汰返回 null） */
  set(key: string, value: unknown | null): string | null {
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
  load(key: string, value: unknown | null): void {
    this.map.set(key, value);
  }
}

const mem = new LruMap();

/** 启动时从 Dexie 初始化内存 LRU，保证两者同步；只执行一次 */
let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!IS_WEB) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = imageMetadataCacheDb.entries
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
 * 在画廊/画册等视图根组件调用，向子树 provide 懒加载 metadata 解析器。
 * clearCache() 已为 no-op（全局 LRU + IndexedDB 自动管理容量，无需手动清空）。
 */
export function useProvideImageMetadataCache() {
  async function resolveMetadata(
    imageId: string,
    metadataId?: number,
  ): Promise<unknown | null> {
    await ensureInit();

    const key = cacheKeyFor(imageId, metadataId);

    // 1. 内存 LRU 命中（初始化后与 Dexie 同步，命中内存即命中持久化层）
    if (mem.has(key)) {
      return mem.get(key) ?? null;
    }

    // 2. 后端 IPC 拉取
    const raw =
      metadataId != null
        ? await invoke<unknown | null>("get_image_metadata_by_metadata_id", {
            metadataId,
          })
        : await invoke<unknown | null>("get_image_metadata", { imageId });
    const v = raw ?? null;

    const evictedKey = mem.set(key, v);

    if (IS_WEB) {
      if (evictedKey) {
        // 原子事务：删除被淘汰条目并写入新条目，Dexie 始终 ≤ 1024
        void imageMetadataCacheDb.transaction(
          "rw",
          imageMetadataCacheDb.entries,
          async () => {
            await imageMetadataCacheDb.entries.delete(evictedKey);
            await imageMetadataCacheDb.entries.put({
              cacheKey: key,
              data: v,
              cachedAt: Date.now(),
            });
          },
        );
      } else {
        void imageMetadataCacheDb.entries.put({
          cacheKey: key,
          data: v,
          cachedAt: Date.now(),
        });
      }
    }

    return v;
  }

  // no-op：全局 LRU + IndexedDB 缓存不依赖页面生命周期
  function clearCache() {}

  provide(imageMetadataResolverKey, resolveMetadata);

  return { clearCache, resolveMetadata };
}
