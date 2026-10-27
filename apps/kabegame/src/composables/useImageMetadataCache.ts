import { provide, type InjectionKey } from "vue";
import { invoke } from "../api";
import { IS_WEB } from "../env";
import { imageMetadataCacheDb } from "../cache/imageMetadataCache";

export interface ResolvedImageMetadata {
  data: unknown | null;
  pluginVersion: number;
  /** CLI `--freeze-template` 冻结的描述模板；非空时覆盖插件包内模板 */
  template: string | null;
}

/** 按 metadataId 解析插件 metadata（全局 LRU + IndexedDB 缓存，最多 1024 条） */
export type ImageMetadataResolver = (
  imageId: string,
  metadataId?: number | null,
) => Promise<ResolvedImageMetadata | null>;

export const imageMetadataResolverKey: InjectionKey<ImageMetadataResolver> = Symbol("imageMetadataResolver");

const MAX_CACHE_SIZE = 1024;

function normalizePluginVersion(version: number | null | undefined): number {
  return typeof version === "number" && Number.isFinite(version) && version >= 0 ? Math.floor(version) : 0;
}

/** 空白模板视为未冻结；IndexedDB 旧条目没有该字段，同样归一为 null */
export function normalizeFrozenTemplate(template: unknown): string | null {
  return typeof template === "string" && template.trim() ? template : null;
}

const cacheKeyFor = (metadataId: number): string => `m${metadataId}`;

class LruMap {
  private readonly map = new Map<string, ResolvedImageMetadata>();

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): ResolvedImageMetadata | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  /** 写入并返回被淘汰的 key（无淘汰返回 null） */
  set(key: string, value: ResolvedImageMetadata): string | null {
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
  load(key: string, value: ResolvedImageMetadata): void {
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
        mem.load(cacheKey, { ...data, template: normalizeFrozenTemplate(data.template) });
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
  async function fetchMetadata(imageId: string): Promise<(ResolvedImageMetadata & { id: number }) | null> {
    const full = await invoke<{
      id: number;
      data?: unknown | null;
      pluginVersion?: number | null;
      template?: string | null;
    } | null>("get_image_metadata_full", { imageId });
    if (!full) return null;
    return {
      id: full.id,
      data: full.data ?? null,
      pluginVersion: normalizePluginVersion(full.pluginVersion),
      template: normalizeFrozenTemplate(full.template),
    };
  }

  async function resolveMetadata(imageId: string, metadataId?: number | null): Promise<ResolvedImageMetadata | null> {
    if (metadataId == null) {
      return fetchMetadata(imageId);
    }

    await ensureInit();
    const key = cacheKeyFor(metadataId);

    // 1. 内存 LRU 命中（初始化后与 Dexie 同步，命中内存即命中持久化层）
    if (mem.has(key)) {
      return mem.get(key) ?? null;
    }

    // 2. 后端 IPC 拉取
    const full = await fetchMetadata(imageId);
    if (!full) return null;
    const value: ResolvedImageMetadata = {
      data: full.data,
      pluginVersion: full.pluginVersion,
      template: full.template,
    };
    // 查询期间 metadata 可能已经迁移，必须按返回行自己的 id 缓存。
    const returnedKey = cacheKeyFor(full.id);

    const evictedKey = mem.set(returnedKey, value);

    if (IS_WEB) {
      if (evictedKey) {
        // 原子事务：删除被淘汰条目并写入新条目，Dexie 始终 ≤ 1024
        void imageMetadataCacheDb.transaction("rw", imageMetadataCacheDb.entries, async () => {
          await imageMetadataCacheDb.entries.delete(evictedKey);
          await imageMetadataCacheDb.entries.put({
            cacheKey: returnedKey,
            data: value,
            cachedAt: Date.now(),
          });
        });
      } else {
        void imageMetadataCacheDb.entries.put({
          cacheKey: returnedKey,
          data: value,
          cachedAt: Date.now(),
        });
      }
    }

    return value;
  }

  // no-op：全局 LRU + IndexedDB 缓存不依赖页面生命周期
  function clearCache() {}

  provide(imageMetadataResolverKey, resolveMetadata);

  return { clearCache, resolveMetadata };
}
