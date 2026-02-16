import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

function toPngDataUrl(iconData: number[]): string {
  const bytes = new Uint8Array(iconData);
  const binaryString = Array.from(bytes)
    .map((byte) => String.fromCharCode(byte))
    .join("");
  const base64 = btoa(binaryString);
  return `data:image/png;base64,${base64}`;
}

/** 插件（已安装）的基本信息 */
export interface BrowserPlugin {
  id: string;
  name: string;
  desp: string;
  icon?: string | null;
  filePath?: string | null;
  doc?: string | null;
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
    commandName = "plugin_editor_list_installed_plugins"
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

  return {
    plugins,
    icons,
    isLoading,
    loadPlugins,
    loadIcons,
    loadIcon,
    getIcon,
    clearCache,
  };
});

/**
 * 主程序（main）使用的爬虫插件信息（与后端 `get_plugins/delete_plugin` 对应）
 */
export interface Plugin {
  id: string;
  name: string;
  description: string;
  version: string;
  baseUrl: string;
  sizeBytes: number;
  builtIn: boolean;
  config: Record<string, any>;
  selector?: {
    imageSelector: string;
    nextPageSelector?: string;
    titleSelector?: string;
  };
}

export const usePluginStore = defineStore("plugins", () => {
  const plugins = ref<Plugin[]>([]);
  const activePlugin = ref<Plugin | null>(null);

  async function loadPlugins() {
    try {
      const result = await invoke<Plugin[]>("get_plugins");
      plugins.value = result;
    } catch (error) {
      console.error("加载插件失败:", error);
      throw error;
    }
  }

  async function deletePlugin(pluginId: string) {
    try {
      await invoke("delete_plugin", { pluginId });
      plugins.value = plugins.value.filter((p) => p.id !== pluginId);
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

  return {
    plugins,
    activePlugin,
    loadPlugins,
    deletePlugin,
    setActivePlugin,
  };
});
