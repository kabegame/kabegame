import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

export interface Plugin {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  enabled: boolean;
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

  // 加载插件列表
  async function loadPlugins() {
    try {
      const result = await invoke<Plugin[]>("get_plugins");
      plugins.value = result;
    } catch (error) {
      console.error("加载插件失败:", error);
    }
  }

  // 添加插件
  async function addPlugin(plugin: Omit<Plugin, "id">) {
    try {
      const newPlugin = await invoke<Plugin>("add_plugin", { plugin });
      plugins.value.push(newPlugin);
      return newPlugin;
    } catch (error) {
      console.error("添加插件失败:", error);
      throw error;
    }
  }

  // 更新插件
  async function updatePlugin(pluginId: string, updates: Partial<Plugin>) {
    try {
      const updated = await invoke<Plugin>("update_plugin", {
        pluginId,
        updates,
      });
      const index = plugins.value.findIndex((p) => p.id === pluginId);
      if (index !== -1) {
        plugins.value[index] = updated;
      }
      return updated;
    } catch (error) {
      console.error("更新插件失败:", error);
      throw error;
    }
  }

  // 删除插件
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

  // 设置活动插件
  function setActivePlugin(plugin: Plugin | null) {
    activePlugin.value = plugin;
  }

  // 获取启用的插件
  const enabledPlugins = ref(() => plugins.value.filter((p) => p.enabled));

  return {
    plugins,
    activePlugin,
    enabledPlugins,
    loadPlugins,
    addPlugin,
    updatePlugin,
    deletePlugin,
    setActivePlugin,
  };
});

