import { defineStore } from "pinia";
import { ref, unref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { i18n, resolveConfigText, resolveManifestText } from "@kabegame/i18n";
import { useCrawlerStore } from "./crawler";

/** manifest name/description：后端下发的 Record，键为 "default"（默认）及语言码 "zh"、"ja"、"ko" 等 */
export type PluginManifestText = Record<string, string>;

/** 内置本地导入插件 id（爬虫任务、画廊、任务抽屉一致） */
export const LOCAL_IMPORT_PLUGIN_ID = "local-import" as const;

/**
 * 单条插件记录的展示名（当前全局 locale + manifest；内置 local-import 用 tasks.drawerLocalImport）。
 */
export function resolvePluginRecordDisplayName(plugin: {
  id: string;
  name?: PluginManifestText;
}): string {
  if (plugin.id === LOCAL_IMPORT_PLUGIN_ID) {
    const s = String(i18n.global.t("tasks.drawerLocalImport")).trim();
    return s || plugin.id;
  }
  const locale = String(unref(i18n.global.locale) ?? "en");
  const raw = plugin.name;
  if (!raw || typeof raw !== "object") return plugin.id;
  const n =
    resolveManifestText(raw, locale) ||
    ((raw as Record<string, string>)["default"] ?? plugin.id) ||
    plugin.id;
  if (String(n).trim()) return String(n);
  return plugin.id;
}

/**
 * 按 pluginId 在已安装列表中解析展示名（找不到则回退为 id）。
 */
export function resolvePluginIdDisplayName(
  pluginId: string,
  installed: ReadonlyArray<{ id: string; name?: PluginManifestText }>,
): string {
  if (pluginId === LOCAL_IMPORT_PLUGIN_ID) {
    const s = String(i18n.global.t("tasks.drawerLocalImport")).trim();
    return s || pluginId;
  }
  const plugin = installed.find((p) => p.id === pluginId);
  if (!plugin) return pluginId;
  return resolvePluginRecordDisplayName(plugin);
}

/** 插件文档多语言：键 "default" 及 "zh"、"en"、"ja"、"ko" 等，与 name/description 同构 */
export type PluginManifestDoc = Record<string, string>;

/** 插件 config 变量 name/descripts/options[].name：后端下发的 Record，键为 "default" 及语言码 "zh"、"en" 等，与 manifest 同构 */
export type PluginConfigText = Record<string, string>;

/** 将插件 icon_png_base64 转为 data URL */
export function pluginIconToDataUrl(
  iconPngBase64: string | null | undefined,
): string | undefined {
  if (!iconPngBase64) return undefined;
  return `data:image/png;base64,${iconPngBase64}`;
}

/**
 * 主程序（main）使用的爬虫插件信息（与后端 `get_plugins/refresh_plugins` 对应）
 * 单一类型涵盖已安装、临时打开等所有场景
 */
export interface Plugin {
  id: string;
  /** string 或 { name?, ja?, ko?, ... }，用 @kabegame/i18n 的 usePluginManifestI18n / resolveManifestText 解析后展示 */
  name: PluginManifestText;
  description: PluginManifestText;
  version: string;
  baseUrl: string;
  sizeBytes: number;
  config: Record<string, any>;
  /** 脚本类型：rhai | js。安卓仅支持 rhai。 */
  scriptType?: string;
  /** manifest minAppVersion，运行前由前端校验 */
  minAppVersion?: string | null;
  /** 插件包文件路径（.kgpg），仅已安装插件有值 */
  filePath?: string | null;
  /** 多语言文档 */
  doc?: PluginManifestDoc | null;
  /** 图标 PNG base64（不含 data: 前缀） */
  iconPngBase64?: string | null;
  /** templates/description.ejs 内容 */
  descriptionTemplate?: string | null;
  /** configs/*.json 推荐运行配置列表 */
  recommendedConfigs?: any[];
  /** doc_root 下非 .md 资源（图片等）base64 映射，键为相对 doc_root 的路径 */
  docResources?: Record<string, string> | null;
}

/**
 * 单条爬虫变量元数据：来自 `Plugin.config.vars`（与 `get_plugin_vars` 返回项同构）。
 */
export type PluginVarMeta = {
  name: PluginConfigText | string;
  type?: string;
  optionNameByVariable?: Record<string, PluginConfigText | string>;
  when?: Record<string, string[]>;
};

/**
 * 从已安装插件的 `config`（含后端下发的 `vars` 数组）构建 key → 元数据映射。
 */
export function buildVarMetaMapFromPluginConfig(
  config: Record<string, any> | undefined | null,
): Record<string, PluginVarMeta> {
  const vars = config?.vars;
  if (!Array.isArray(vars)) return {};
  const metaMap: Record<string, PluginVarMeta> = {};
  for (const raw of vars) {
    if (!raw || typeof raw !== "object") continue;
    const key = String((raw as Record<string, unknown>).key ?? "").trim();
    if (!key) continue;
    const optionNameByVariable: Record<string, PluginConfigText | string> = {};
    const opts = (raw as Record<string, unknown>).options;
    if (Array.isArray(opts)) {
      for (const opt of opts) {
        if (typeof opt === "string") {
          optionNameByVariable[opt] = opt;
        } else if (opt && typeof opt === "object") {
          const o = opt as Record<string, unknown>;
          const variable = String(o.variable ?? "").trim();
          if (!variable) continue;
          const name = o.name;
          optionNameByVariable[variable] =
            name !== undefined && name !== null
              ? (name as PluginConfigText | string)
              : variable;
        }
      }
    }
    const whenRaw = (raw as Record<string, unknown>).when;
    const when =
      whenRaw && typeof whenRaw === "object" && !Array.isArray(whenRaw)
        ? (whenRaw as Record<string, string[]>)
        : undefined;
    metaMap[key] = {
      name:
        ((raw as Record<string, unknown>).name as PluginConfigText | string) ??
        key,
      type:
        typeof (raw as Record<string, unknown>).type === "string"
          ? String((raw as Record<string, unknown>).type)
          : undefined,
      optionNameByVariable:
        Object.keys(optionNameByVariable).length > 0
          ? optionNameByVariable
          : undefined,
      when,
    };
  }
  return metaMap;
}

/** 内置本地导入插件的变量展示名（需传入 `t` 以随语言切换）。 */
export function localImportVarMetaMap(
  t: (key: string) => string,
): Record<string, PluginVarMeta> {
  return {
    paths: { name: t("tasks.drawerPathsMeta"), type: "text" },
    recursive: { name: t("tasks.drawerRecursiveMeta"), type: "boolean" },
  };
}

/**
 * 解析某插件下某变量的展示名（已安装列表 + 内置 local-import）。
 */
export function resolvePluginVarDisplayName(
  pluginId: string,
  varKey: string,
  localeCode: string,
  installed: ReadonlyArray<Plugin>,
  t: (key: string) => string,
): string {
  const meta =
    pluginId === LOCAL_IMPORT_PLUGIN_ID
      ? localImportVarMetaMap(t)[varKey]
      : buildVarMetaMapFromPluginConfig(
          installed.find((p) => p.id === pluginId)?.config,
        )[varKey];
  const rawName = meta?.name;
  if (rawName == null) return varKey;
  if (typeof rawName === "string") return rawName;
  return (
    resolveConfigText(rawName as PluginConfigText, localeCode) ||
    (rawName as Record<string, string>)["default"] ||
    varKey
  );
}

export const usePluginStore = defineStore("plugins", () => {
  const plugins = ref<Plugin[]>([]);
  const activePlugin = ref<Plugin | null>(null);
  /** 插件详情页缓存（按路由 key 存；已安装和商店插件共用） */
  const pluginDetailCache = ref<Record<string, Plugin>>({});

  let eventListenersInitialized = false;

  /** 按 id 字典序排序（稳定 — Array.prototype.sort 在现代 JS 引擎里是稳定的） */
  function sortPluginsById(list: Plugin[]): Plugin[] {
    return [...list].sort((a, b) => a.id.localeCompare(b.id));
  }

  const initEventListeners = async () => {
    if (eventListenersInitialized) return;
    eventListenersInitialized = true;
    try {
      const { listen } = await import("@tauri-apps/api/event");

      await listen<{ plugin: Plugin }>("plugin-added", (event) => {
        const p = event.payload?.plugin as Plugin;
        if (!p?.id) return;
        if (!plugins.value.some((x) => x.id === p.id)) {
          plugins.value = sortPluginsById([...plugins.value, p]);
        }
        const crawler = useCrawlerStore();
        crawler.loadPluginRecommendedConfigs(plugins.value);
      });

      await listen<{ plugin: Plugin }>("plugin-updated", (event) => {
        const p = event.payload?.plugin as Plugin;
        if (!p?.id) return;
        const idx = plugins.value.findIndex((x) => x.id === p.id);
        if (idx >= 0) {
          const next = plugins.value.slice();
          next[idx] = p;
          plugins.value = sortPluginsById(next);
        } else {
          plugins.value = sortPluginsById([...plugins.value, p]);
        }
        const crawler = useCrawlerStore();
        crawler.loadPluginRecommendedConfigs(plugins.value);
      });

      await listen<{ pluginId: string }>("plugin-deleted", (event) => {
        const id = String(event.payload?.pluginId ?? "").trim();
        if (!id) return;
        plugins.value = sortPluginsById(plugins.value.filter((p) => p.id !== id));
        if (activePlugin.value?.id === id) activePlugin.value = null;
        delete pluginDetailCache.value[id];
      });
    } catch (e) {
      console.warn("init plugin event listeners failed", e);
    }
  };

  /** 从已加载的插件列表中返回图标 data URL */
  function pluginIconDataUrl(pluginId: string): string | undefined {
    const p = plugins.value.find((x) => x.id === pluginId);
    return pluginIconToDataUrl(p?.iconPngBase64);
  }

  /** 从已加载的插件列表中返回多语言 doc */
  function pluginDoc(pluginId: string): PluginManifestDoc | null | undefined {
    const p = plugins.value.find((x) => x.id === pluginId);
    if (!p) return undefined;
    return p.doc ?? null;
  }

  /** 从已加载的插件列表中返回 description.ejs 模板内容 */
  function pluginDescriptionTemplate(pluginId: string): string | undefined {
    const p = plugins.value.find((x) => x.id === pluginId);
    const v = p?.descriptionTemplate;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  }

  /** 从缓存读取插件列表（不重新扫盘）；首次调用时由 startup 的 ensure_installed_cache_initialized 保证缓存已就绪 */
  async function loadPlugins(): Promise<void> {
    await initEventListeners();
    return invoke<Plugin[]>("get_plugins")
      .then((result) => {
        const sorted = sortPluginsById(result);
        plugins.value = sorted;
        console.log("已加载插件列表:", sorted);
        const crawler = useCrawlerStore();
        crawler.loadPluginRecommendedConfigs(sorted);
      })
      .catch((error) => {
        console.error("加载插件失败:", error);
        throw error;
      });
  }

  /** 重新扫描磁盘并刷新缓存（用于手动刷新、安装/删除后） */
  async function refreshPlugins(): Promise<void> {
    try {
      const result = await invoke<Plugin[]>("refresh_plugins");
      const sorted = sortPluginsById(result);
      plugins.value = sorted;
      const crawler = useCrawlerStore();
      crawler.loadPluginRecommendedConfigs(sorted);
    } catch (error) {
      console.error("刷新插件失败:", error);
      throw error;
    }
  }

  async function deletePlugin(pluginId: string) {
    try {
      await invoke("delete_plugin", { pluginId });
      // plugin-deleted event handles store update
    } catch (error) {
      console.error("删除插件失败:", error);
      throw error;
    }
  }

  function setActivePlugin(plugin: Plugin | null) {
    activePlugin.value = plugin;
  }

  function getCachedPluginDetail(key: string): Plugin | undefined {
    return pluginDetailCache.value[key];
  }

  function setCachedPluginDetail(key: string, plugin: Plugin) {
    pluginDetailCache.value[key] = plugin;
  }

  function clearPluginDetailCache() {
    pluginDetailCache.value = {};
  }

  function pluginLabel(pluginId: string): string {
    return resolvePluginIdDisplayName(pluginId, plugins.value);
  }

  /** 使用当前 store 中的已安装列表解析变量展示名（不含内置 local-import，需自行处理）。 */
  function resolveVarDisplayName(
    pluginId: string,
    varKey: string,
    localeCode: string,
    t: (key: string) => string,
  ): string {
    return resolvePluginVarDisplayName(
      pluginId,
      varKey,
      localeCode,
      plugins.value,
      t,
    );
  }

  return {
    plugins,
    activePlugin,
    pluginDetailCache,
    loadPlugins,
    refreshPlugins,
    pluginIconDataUrl,
    pluginDoc,
    pluginDescriptionTemplate,
    deletePlugin,
    setActivePlugin,
    getCachedPluginDetail,
    setCachedPluginDetail,
    clearPluginDetailCache,
    pluginLabel,
    buildVarMetaMapFromPluginConfig,
    localImportVarMetaMap,
    resolveVarDisplayName,
  };
});
