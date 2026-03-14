import { defineStore } from "pinia";
import { ref } from "vue";

export interface CrawlerDrawerInitialConfig {
  pluginId?: string;
  outputDir?: string;
  vars?: Record<string, any>;
  httpHeaders?: Record<string, string>;
  outputAlbumId?: string | null;
}

/** 上次运行时的表单快照，用于关闭对话框再打开时恢复 */
export interface LastRunConfig {
  pluginId: string;
  outputDir: string;
  vars: Record<string, any>;
  httpHeaders: Record<string, string>;
  outputAlbumId: string | null;
}

export const useCrawlerDrawerStore = defineStore("crawlerDrawer", () => {
  const visible = ref(false);
  const initialConfig = ref<CrawlerDrawerInitialConfig | undefined>(undefined);
  /** 上次「开始收集」时的配置快照，对话框再次打开且无 initialConfig 时恢复 */
  const lastRunConfig = ref<LastRunConfig | null>(null);

  function open(config?: CrawlerDrawerInitialConfig) {
    initialConfig.value = config;
    visible.value = true;
  }

  function close() {
    visible.value = false;
    // 延迟清空配置，确保组件能读取到
    setTimeout(() => {
      initialConfig.value = undefined;
    }, 300);
  }

  function toggle(config?: CrawlerDrawerInitialConfig) {
    if (visible.value) {
      close();
    } else {
      open(config);
    }
  }

  function setLastRunConfig(config: LastRunConfig | null) {
    lastRunConfig.value = config;
  }

  return {
    visible,
    initialConfig,
    lastRunConfig,
    open,
    close,
    toggle,
    setLastRunConfig,
  };
});
