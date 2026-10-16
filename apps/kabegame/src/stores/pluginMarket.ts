import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { invoke, listen } from "../api";
import { IS_WEB } from "../env";
import { storePluginCacheDb } from "../cache/storePluginCache";
import { usePluginStore, type PluginManifestText } from "./plugins";
import type { PluginLabel } from "./pluginLabels";

/** 与后端 `plugin_sources::OFFICIAL_PLUGIN_SOURCE_ID` 一致 */
export const OFFICIAL_PLUGIN_SOURCE_ID = "official_github_release";
/** 与 `kabegame_core::storage::plugin_sources` 插入官方源时的默认 `name` 一致（用于识别「未自定义」以走 i18n） */
export const OFFICIAL_PLUGIN_SOURCE_DEFAULT_DB_NAME = "官方 GitHub Releases 源";

/** 打开商店 tab 时后台重拉 index 的缓存最大年龄（与后端 `plugin_source_cache.updated_at` 比较，秒） */
const STORE_INDEX_REVALIDATE_MAX_AGE_SECS = 24 * 60 * 60;

export interface PluginSource {
  id: string;
  name: string;
  indexUrl: string;
}

export interface StorePluginResolved {
  id: string;
  /** 与已安装插件一致：i18n 对象 { default, zh?, ja?, ... }，由后端从 index.json 归一化 */
  name: PluginManifestText;
  version: string;
  /** 与已安装插件一致：i18n 对象 { default, zh?, ja?, ... }，由后端从 index.json 归一化 */
  description: PluginManifestText;
  downloadUrl: string;
  iconUrl?: string | null;
  packageVersion?: number | null;
  sha256?: string | null;
  sizeBytes: number;
  sourceId: string;
  sourceName: string;
  /** 读取时由 store 按当前已安装列表现算，不以后端返回值为准 */
  installedVersion?: string | null;
  /** 后端 get_store_plugins 合并的当前下载进度 0–100 */
  storeDownloadProgress?: number | null;
  storeDownloadError?: string | null;
  labels?: PluginLabel[];
  minAppIncompatible?: boolean;
}

/** 远程图标缓存 key：与本地已安装图标隔离，商店条目即使 id 相同也不命中本地 icon */
export const storeIconKey = (sourceId: string, pluginId: string) => `store:${sourceId}:${pluginId}`;

/** 用于比对商店列表是否变化（仅 id + version，排序后拼接） */
const storePluginListSignature = (plugins: StorePluginResolved[]) =>
  [...plugins]
    .map((p) => `${p.id}\x1f${p.version}`)
    .sort()
    .join("\n");

const errorMessageOf = (e: unknown, fallback: string): string => {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || e.toString();
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return fallback;
};

/**
 * 插件商店数据（商店源列表、各源插件列表、远程图标）的唯一属主。
 *
 * 生命周期：按需加载（`ensure*` 只在未加载时拉取）→ 保存在 store 里跨路由复用 →
 * `plugin-sources-changed` 事件被动刷新源列表。自身写操作完成后由调用方直接 `loadSources()`，
 * 不依赖事件回刷；重复刷新幂等。
 */
export const usePluginMarketStore = defineStore("pluginMarket", () => {
  const pluginStore = usePluginStore();

  const sources = ref<PluginSource[]>([]);
  const sourcesLoaded = ref(false);
  /** 后端原始列表；`installedVersion` 不写回这里，见 `pluginsBySource` */
  const rawPluginsBySource = ref<Record<string, StorePluginResolved[]>>({});
  /** 成功加载过的源 */
  const loadedBySource = ref<Record<string, boolean>>({});
  /** 加载过（成功或失败）的源：用于区分「还没拉」与「拉完是空 / 失败」 */
  const settledBySource = ref<Record<string, boolean>>({});
  const loadingBySource = ref<Record<string, boolean>>({});
  const pluginIcons = ref<Record<string, string>>({});
  const pluginIconLoading = ref<Record<string, boolean>>({});

  const loadInflight = new Map<string, Promise<void>>();
  const revalidateInflight = new Set<string>();
  let sourcesInflight: Promise<{ success: boolean; error?: string }> | null = null;
  let listenersInitialized = false;

  const installedVersionById = computed(() => {
    const m = new Map<string, string>();
    for (const p of pluginStore.visiblePlugins) {
      if (p?.id) m.set(p.id, p.version);
    }
    return m;
  });

  /** 已安装列表变化（plugin-added/updated/deleted 驱动 pluginStore）时自动重算，无需重拉商店 */
  const pluginsBySource = computed(() => {
    const m = installedVersionById.value;
    const out: Record<string, StorePluginResolved[]> = {};
    for (const [sourceId, arr] of Object.entries(rawPluginsBySource.value)) {
      out[sourceId] = (arr || []).map((p) => ({ ...p, installedVersion: m.get(p.id) ?? null }));
    }
    return out;
  });

  const storePlugins = (sourceId: string): StorePluginResolved[] => pluginsBySource.value[sourceId] || [];

  const setKey = <T>(target: { value: Record<string, T> }, key: string, value: T | undefined) => {
    const next = { ...target.value };
    if (value === undefined) delete next[key];
    else next[key] = value;
    target.value = next;
  };

  /** 清掉某个源的列表、加载标记与远程图标 */
  const forgetSource = (sourceId: string) => {
    setKey(rawPluginsBySource, sourceId, undefined);
    setKey(loadedBySource, sourceId, undefined);
    setKey(settledBySource, sourceId, undefined);
    const prefix = storeIconKey(sourceId, "");
    pluginIcons.value = Object.fromEntries(Object.entries(pluginIcons.value).filter(([k]) => !k.startsWith(prefix)));
  };

  // ---- 远程图标：index.json 不提供 iconUrl 时，从 .kgpg 固定头部通过 Range 读取 icon（后端返回 PNG bytes）----

  const loadRemotePluginIcon = async (plugin: StorePluginResolved) => {
    if (!plugin?.id || !plugin.sourceId || !plugin.downloadUrl) return;
    // 有同 id 的已安装插件 → 图标从已安装数据取，无需远程拉取
    if (installedVersionById.value.has(plugin.id)) return;
    const key = storeIconKey(plugin.sourceId, plugin.id);
    if (pluginIcons.value[key] || pluginIconLoading.value[key]) return;
    // web 模式：先查 Dexie icon 缓存（版本匹配）
    if (IS_WEB && plugin.version) {
      const cached = await storePluginCacheDb.icons.get(key);
      if (cached && cached.version === plugin.version) {
        setKey(pluginIcons, key, `data:image/png;base64,${cached.iconBase64}`);
        return;
      }
    }
    setKey(pluginIconLoading, key, true);
    try {
      const iconData = await invoke<number[] | null>("get_remote_plugin_icon", {
        downloadUrl: plugin.downloadUrl,
        sourceId: plugin.sourceId,
        pluginId: plugin.id,
      });
      if (!iconData || iconData.length === 0) return;
      const binaryString = Array.from(new Uint8Array(iconData))
        .map((byte) => String.fromCharCode(byte))
        .join("");
      const base64 = btoa(binaryString);
      setKey(pluginIcons, key, `data:image/png;base64,${base64}`);
      if (IS_WEB && plugin.version) {
        void storePluginCacheDb.icons.put({ key, version: plugin.version, iconBase64: base64, cachedAt: Date.now() });
      }
    } catch {
      // 远程 icon 拉取失败：保持占位符即可
    } finally {
      setKey(pluginIconLoading, key, undefined);
    }
  };

  const prefetchRemoteIconsForSource = async (sourceId: string) => {
    const installed = installedVersionById.value;
    // 控制规模：只预取前 24 个缺失 iconUrl 的条目，避免刷新时并发过多；已安装同 id 者跳过
    const targets = (rawPluginsBySource.value[sourceId] || [])
      .filter((p) => {
        if (installed.has(p.id)) return false;
        const pv = typeof p.packageVersion === "number" ? p.packageVersion : 1;
        return pv >= 2 && !p.iconUrl && !!p.downloadUrl;
      })
      .slice(0, 24);
    // 有限并发：最多同时拉 10 个
    let idx = 0;
    const workers = new Array(Math.min(10, targets.length)).fill(0).map(async () => {
      while (idx < targets.length) {
        const cur = targets[idx];
        idx += 1;
        // eslint-disable-next-line no-await-in-loop
        await loadRemotePluginIcon(cur);
      }
    });
    await Promise.all(workers);
  };

  const restoreIconsFromCache = async (sourceId: string) => {
    if (!IS_WEB) return;
    const arr = rawPluginsBySource.value[sourceId] || [];
    if (!arr.length) return;
    const installed = installedVersionById.value;
    const updates: Record<string, string> = {};
    await Promise.all(
      arr
        .filter((p) => !p.iconUrl && !installed.has(p.id))
        .map(async (p) => {
          const key = storeIconKey(sourceId, p.id);
          if (pluginIcons.value[key]) return;
          const cached = await storePluginCacheDb.icons.get(key);
          if (cached && cached.version === p.version) {
            updates[key] = `data:image/png;base64,${cached.iconBase64}`;
          }
        }),
    );
    if (Object.keys(updates).length) {
      pluginIcons.value = { ...pluginIcons.value, ...updates };
    }
  };

  /** 列表落地后：先从 Dexie 还原图标缓存，再按需发起远程拉取（均不阻塞调用方） */
  const afterListChanged = (sourceId: string) => {
    void restoreIconsFromCache(sourceId).then(() => prefetchRemoteIconsForSource(sourceId));
  };

  // ---- 源列表 ----

  const initEventListeners = async () => {
    if (listenersInitialized) return;
    listenersInitialized = true;
    try {
      // 被动刷新：CLI / IPC / 语言切换（官方源名 i18n 同步）等外部改动
      await listen("plugin-sources-changed", () => {
        void loadSources();
      });
    } catch (e) {
      console.warn("init plugin market event listeners failed", e);
    }
  };

  const doLoadSources = async (): Promise<{ success: boolean; error?: string }> => {
    const prevById = new Map(sources.value.map((s) => [s.id, s]));
    let next: PluginSource[];
    try {
      next = (await invoke<PluginSource[]>("get_plugin_sources")) || [];
    } catch (e) {
      console.error("加载商店源失败:", e);
      return { success: false, error: errorMessageOf(e, "加载商店源失败") };
    }
    sources.value = next;
    sourcesLoaded.value = true;

    const nextIds = new Set(next.map((s) => s.id));
    const cachedIds = new Set([...Object.keys(rawPluginsBySource.value), ...Object.keys(settledBySource.value)]);
    for (const id of cachedIds) {
      if (!nextIds.has(id)) forgetSource(id);
    }
    // index 地址变了：旧缓存不再可信，已加载的源直接从远程重拉
    for (const s of next) {
      const prev = prevById.get(s.id);
      if (prev && prev.indexUrl !== s.indexUrl && settledBySource.value[s.id]) {
        void loadStorePlugins(s.id, { forceRefresh: true }).catch((e) =>
          console.warn("商店源地址变更后重拉失败:", s.id, e),
        );
      }
    }
    return { success: true };
  };

  /** 重新拉取源列表（并发调用合并为一次）；不存在的源会连同其缓存一起清掉 */
  const loadSources = (): Promise<{ success: boolean; error?: string }> => {
    void initEventListeners();
    if (!sourcesInflight) {
      sourcesInflight = doLoadSources().finally(() => {
        sourcesInflight = null;
      });
    }
    return sourcesInflight;
  };

  /** 源列表未加载过才拉取 */
  const ensureSources = async (): Promise<{ success: boolean; error?: string }> => {
    if (sourcesLoaded.value) {
      void initEventListeners();
      return { success: true };
    }
    return loadSources();
  };

  // ---- 商店插件列表 ----

  /**
   * 拉取某个源的商店插件列表；失败抛错，由调用方决定如何提示。
   * @param options.forceRefresh 强制从远程刷新（忽略后端本地缓存），用于用户手动刷新
   */
  const loadStorePlugins = (sourceId: string, options: { forceRefresh?: boolean } = {}): Promise<void> => {
    const { forceRefresh = false } = options;
    const inflight = loadInflight.get(sourceId);
    if (inflight && !forceRefresh) return inflight;

    const task = (async () => {
      setKey(loadingBySource, sourceId, true);
      try {
        const plugins = await invoke<StorePluginResolved[]>("get_store_plugins", { sourceId, forceRefresh });
        setKey(rawPluginsBySource, sourceId, plugins || []);
        setKey(loadedBySource, sourceId, true);
        afterListChanged(sourceId);
      } finally {
        setKey(settledBySource, sourceId, true);
        setKey(loadingBySource, sourceId, undefined);
      }
    })().finally(() => {
      if (loadInflight.get(sourceId) === task) loadInflight.delete(sourceId);
    });
    loadInflight.set(sourceId, task);
    return task;
  };

  /** 该源未成功加载过才拉取（优先后端本地缓存） */
  const ensureStorePlugins = async (sourceId: string): Promise<void> => {
    if (loadedBySource.value[sourceId]) return;
    await loadStorePlugins(sourceId);
  };

  /**
   * 静默后台：若后端 index 缓存超过 `STORE_INDEX_REVALIDATE_MAX_AGE_SECS` 则重拉；不碰 loading 状态，失败完全静默。
   * @returns 列表是否发生了变化且此前已有内容（调用方据此决定是否提示「已自动更新」）
   */
  const revalidateInBackground = async (sourceId: string): Promise<boolean> => {
    if (revalidateInflight.has(sourceId)) return false;
    revalidateInflight.add(sourceId);
    try {
      const prev = rawPluginsBySource.value[sourceId];
      const plugins = await invoke<StorePluginResolved[]>("get_store_plugins", {
        sourceId,
        forceRefresh: false,
        revalidateIfStaleAfterSecs: STORE_INDEX_REVALIDATE_MAX_AGE_SECS,
      });
      if (!plugins?.length) return false;
      if (storePluginListSignature(prev ?? []) === storePluginListSignature(plugins)) return false;
      setKey(rawPluginsBySource, sourceId, plugins);
      setKey(loadedBySource, sourceId, true);
      setKey(settledBySource, sourceId, true);
      afterListChanged(sourceId);
      return !!prev && prev.length > 0;
    } catch {
      return false;
    } finally {
      revalidateInflight.delete(sourceId);
    }
  };

  return {
    sources,
    sourcesLoaded,
    loadedBySource,
    settledBySource,
    loadingBySource,
    pluginsBySource,
    pluginIcons,
    pluginIconLoading,
    storePlugins,
    loadSources,
    ensureSources,
    loadStorePlugins,
    ensureStorePlugins,
    revalidateInBackground,
    forgetSource,
  };
});
