import { defineStore } from "pinia";
import { ref } from "vue";

export interface WebpageCollectInitialConfig {
  userConfig?: Record<string, any>;
  outputDir?: string;
  httpHeaders?: Record<string, string>;
  outputAlbumId?: string | null;
}

export interface LocalImportInitialConfig {
  paths?: string[];
  recursive?: boolean;
  outputAlbumId?: string | null;
  outputDir?: string;
  copyToDir?: boolean;
}

export const useCollectDialogsStore = defineStore("collectDialogs", () => {
  const webpageVisible = ref(false);
  const webpageInitial = ref<WebpageCollectInitialConfig | undefined>(undefined);
  const localImportVisible = ref(false);
  const localImportInitial = ref<LocalImportInitialConfig | undefined>(undefined);

  function openWebpage(config: WebpageCollectInitialConfig) {
    webpageInitial.value = config;
    webpageVisible.value = true;
  }

  function openLocalImport(config: LocalImportInitialConfig) {
    localImportInitial.value = config;
    localImportVisible.value = true;
  }

  return {
    webpageVisible,
    webpageInitial,
    localImportVisible,
    localImportInitial,
    openWebpage,
    openLocalImport,
  };
});
