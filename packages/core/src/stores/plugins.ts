import { defineStore } from "pinia";
import { ref, unref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { i18n, resolveConfigText, resolveManifestText } from "@kabegame/i18n";
import { useCrawlerStore } from "./crawler";

function toPngDataUrl(iconData: number[]): string {
  const bytes = new Uint8Array(iconData);
  const binaryString = Array.from(bytes)
    .map((byte) => String.fromCharCode(byte))
    .join("");
  const base64 = btoa(binaryString);
  return `data:image/png;base64,${base64}`;
}

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

/** 插件文档多语言：键 "default" 及 "zh"、"en"、"ja"、"ko" 等，与 name/desp 同构 */
export type PluginManifestDoc = Record<string, string>;

/** 插件 config 变量 name/descripts/options[].name：后端下发的 Record，键为 "default" 及语言码 "zh"、"en" 等，与 manifest 同构 */
export type PluginConfigText = Record<string, string>;

/** 插件（已安装）的基本信息 */
export interface BrowserPlugin {
  id: string;
  name: PluginManifestText;
  desp: PluginManifestText;
  /** manifest 版本（详情接口或路由 query 可提供） */
  version?: string | null;
  /** manifest minAppVersion */
  minAppVersion?: string | null;
  icon?: string | null;
  filePath?: string | null;
  doc?: PluginManifestDoc | null;
  baseUrl?: string | null;
}

/**
 * 共用的插件 store
 * 用于管理已安装插件列表和图标缓存
 */
export const useInstalledPluginsStore = defineStore("installedPlugins", () => {
  /** 已安装的插件列表 */
  const plugins = ref<BrowserPlugin[]>([]);
  /** 插件图标缓存（key: pluginId, value: data URL） */
  const icons = ref<Record<string, string>>({});
  /** 是否正在加载插件列表 */
  const isLoading = ref(false);

  /**
   * 加载已安装插件列表
   * @param commandName 后端命令名称（默认 "plugin_editor_list_installed_plugins"）
   */
  async function loadPlugins(
    commandName = "plugin_editor_list_installed_plugins",
  ) {
    isLoading.value = true;
    try {
      plugins.value = await invoke<BrowserPlugin[]>(commandName);
      // 加载图标
      await loadIcons();
    } catch (e) {
      plugins.value = [];
      console.error("加载插件列表失败:", e);
    } finally {
      isLoading.value = false;
    }
  }

  /**
   * 加载所有已安装插件的图标
   */
  async function loadIcons() {
    for (const plugin of plugins.value) {
      if (icons.value[plugin.id]) continue; // 已加载
      await loadIcon(plugin.id);
    }
  }

  /**
   * 加载单个插件的图标
   * @param pluginId 插件 ID
   */
  async function loadIcon(pluginId: string) {
    if (!pluginId || icons.value[pluginId]) return;
    try {
      const iconData = await invoke<number[] | null>("get_plugin_icon", {
        pluginId,
      });
      if (iconData && iconData.length > 0) {
        icons.value[pluginId] = toPngDataUrl(iconData);
      }
    } catch {
      // 图标加载失败，忽略（插件可能没有图标）
    }
  }

  /**
   * 获取插件图标 URL
   * @param pluginId 插件 ID
   * @returns 图标的 data URL，如果没有则返回 undefined
   */
  function getIcon(pluginId: string): string | undefined {
    return icons.value[pluginId];
  }

  /**
   * 清除缓存（用于刷新）
   */
  function clearCache() {
    plugins.value = [];
    icons.value = {};
  }

  function pluginLabel(pluginId: string): string {
    return resolvePluginIdDisplayName(pluginId, plugins.value);
  }

  return {
    plugins,
    icons,
    isLoading,
    loadPlugins,
    loadIcons,
    loadIcon,
    getIcon,
    clearCache,
    pluginLabel,
  };
});

/**
 * 主程序（main）使用的爬虫插件信息（与后端 `get_plugins/delete_plugin` 对应）
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
            name !== undefined && name !== null ? (name as PluginConfigText | string) : variable;
        }
      }
    }
    const whenRaw = (raw as Record<string, unknown>).when;
    const when =
      whenRaw && typeof whenRaw === "object" && !Array.isArray(whenRaw)
        ? (whenRaw as Record<string, string[]>)
        : undefined;
    metaMap[key] = {
      name: ((raw as Record<string, unknown>).name as PluginConfigText | string) ?? key,
      type: typeof (raw as Record<string, unknown>).type === "string"
        ? String((raw as Record<string, unknown>).type)
        : undefined,
      optionNameByVariable:
        Object.keys(optionNameByVariable).length > 0 ? optionNameByVariable : undefined,
      when,
    };
  }
  return metaMap;
}

/** 内置本地导入插件的变量展示名（需传入 `t` 以随语言切换）。 */
export function localImportVarMetaMap(t: (key: string) => string): Record<string, PluginVarMeta> {
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
  const pluginDetailCache = ref<Record<string, BrowserPlugin>>({});
  /** 已安装插件图标 data URL，与插件列表同生命周期（loadPlugins 时整表刷新） */
  const pluginIcons = ref<Record<string, string>>({});
  /** 已安装插件 doc 多语言 Markdown；`null` 表示已拉取但无文档 */
  const pluginDocs = ref<Record<string, PluginManifestDoc | null>>({});

  async function loadPluginIcons() {
    await Promise.all(
      plugins.value.map(async (p) => {
        const pluginId = p.id;
        if (!pluginId || pluginIcons.value[pluginId]) return;
        try {
          const iconData = await invoke<number[] | null>("get_plugin_icon", { pluginId });
          if (iconData && iconData.length > 0) {
            pluginIcons.value = { ...pluginIcons.value, [pluginId]: toPngDataUrl(iconData) };
          }
        } catch {
          // 无图标或失败时保持空
        }
      }),
    );
  }

  async function loadPluginDocs() {
    await Promise.all(
      plugins.value.map(async (p) => {
        const pluginId = p.id;
        if (!pluginId || Object.prototype.hasOwnProperty.call(pluginDocs.value, pluginId)) {
          return;
        }
        try {
          const doc = await invoke<PluginManifestDoc | null>("get_plugin_doc_by_id", {
            pluginId,
          });
          pluginDocs.value = { ...pluginDocs.value, [pluginId]: doc ?? null };
        } catch {
          pluginDocs.value = { ...pluginDocs.value, [pluginId]: null };
        }
      }),
    );
  }

  function pluginIconUrl(pluginId: string): string | undefined {
    return pluginIcons.value[pluginId];
  }

  /** 已加载的 doc；`undefined` 表示尚未随 loadPlugins 拉取 */
  function pluginDoc(pluginId: string): PluginManifestDoc | null | undefined {
    if (!Object.prototype.hasOwnProperty.call(pluginDocs.value, pluginId)) {
      return undefined;
    }
    return pluginDocs.value[pluginId] ?? null;
  }

  function loadPlugins(): Promise<void> {
    return invoke<Plugin[]>("get_plugins")
      .then((result) => {
        plugins.value = result;
        pluginIcons.value = {};
        pluginDocs.value = {};
        const crawler = useCrawlerStore();
        void Promise.all([
          crawler.loadPluginRecommendedConfigs(),
          loadPluginIcons(),
          loadPluginDocs(),
        ]);
      })
      .catch((error) => {
        console.error("加载插件失败:", error);
        throw error;
      });
  }

  async function deletePlugin(pluginId: string) {
    try {
      await invoke("delete_plugin", { pluginId });
      plugins.value = plugins.value.filter((p) => p.id !== pluginId);
      if (pluginIcons.value[pluginId]) {
        const next = { ...pluginIcons.value };
        delete next[pluginId];
        pluginIcons.value = next;
      }
      if (Object.prototype.hasOwnProperty.call(pluginDocs.value, pluginId)) {
        const next = { ...pluginDocs.value };
        delete next[pluginId];
        pluginDocs.value = next;
      }
      if (activePlugin.value?.id === pluginId) {
        activePlugin.value = null;
      }
    } catch (error) {
      console.error("删除插件失败:", error);
      throw error;
    }
  }

  function setActivePlugin(plugin: Plugin | null) {
    activePlugin.value = plugin;
  }

  function getCachedPluginDetail(key: string): BrowserPlugin | undefined {
    return pluginDetailCache.value[key];
  }

  function setCachedPluginDetail(key: string, plugin: BrowserPlugin) {
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
    return resolvePluginVarDisplayName(pluginId, varKey, localeCode, plugins.value, t);
  }

  return {
    plugins,
    activePlugin,
    pluginDetailCache,
    pluginIcons,
    pluginDocs,
    loadPlugins,
    loadPluginIcons,
    loadPluginDocs,
    pluginIconUrl,
    pluginDoc,
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
