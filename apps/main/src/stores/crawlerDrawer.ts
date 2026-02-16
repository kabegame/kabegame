import { defineStore } from "pinia";
import { ref } from "vue";

export interface CrawlerDrawerInitialConfig {
  pluginId?: string;
  outputDir?: string;
  vars?: Record<string, any>;
}

export const useCrawlerDrawerStore = defineStore("crawlerDrawer", () => {
  const visible = ref(false);
  const initialConfig = ref<CrawlerDrawerInitialConfig | undefined>(undefined);

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

  return {
    visible,
    initialConfig,
    open,
    close,
    toggle,
  };
});
