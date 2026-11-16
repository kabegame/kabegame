import { defineStore } from "pinia";
import { ref, watch, type Ref } from "vue";
import { IS_ANDROID, IS_WEB } from "@/env";
import { useUiStore } from "@/stores/ui";
import { trackEvent } from "@/track/umami";
import { currentUrl } from "@/track/imageAnalytics";

/**
 * 收集入口只有两个：「本地」与「网络」，各是一个对话框，顶部分段切换来源。
 * 入口（页头「开始收集」、画廊空状态）只调这里，界面由全局的 `CollectEntryHost` 承载，
 * 所以任何页面放上页头的收集按钮都能用，不用各自接事件。
 * - 本地：文件夹（local-import）/ WPE 壁纸（本机 Wallpaper Engine 目录探测）
 * - 网络：插件 / 网页（webpage）/ Steam（创意工坊订阅）
 * 两组各记一个「上次打开的来源」（localStorage），下次打开默认停在那里。
 */
export type CollectGroup = "local" | "network";
export type LocalSource = "folder" | "wpe";
export type NetworkSource = "plugin" | "webpage" | "steam";

/**
 * 各平台可用的来源（显隐规则只写在这里）：
 * Web 没有本地导入、网页收集（服务端 SSRF）与 WPE；Android 没有 WPE / Steam。
 */
export const LOCAL_SOURCES: readonly LocalSource[] = IS_WEB ? [] : IS_ANDROID ? ["folder"] : ["folder", "wpe"];
export const NETWORK_SOURCES: readonly NetworkSource[] = IS_WEB
  ? ["plugin"]
  : IS_ANDROID
    ? ["plugin", "webpage"]
    : ["plugin", "webpage", "steam"];
/** 当前平台的入口分组（Web 没有本地） */
export const COLLECT_GROUPS: readonly CollectGroup[] = LOCAL_SOURCES.length ? ["local", "network"] : ["network"];

export interface WebpageCollectInitialConfig {
  userConfig?: Record<string, any>;
  outputDir?: string;
  httpHeaders?: Record<string, string>;
  outputAlbumId?: string | null;
  isDryRun?: boolean;
  retryCount?: number;
}

export interface LocalImportInitialConfig {
  paths?: string[];
  recursive?: boolean;
  outputAlbumId?: string | null;
  outputDir?: string;
  copyToDir?: boolean;
  isDryRun?: boolean;
}

const LOCAL_SOURCE_KEY = "kabegame-collect-local-source";
const NETWORK_SOURCE_KEY = "kabegame-collect-network-source";

/** 读上次的来源；读不到或当前平台不可用时取第一个。存储不可用（隐私窗口等）时照常工作。 */
function rememberedSource<T extends string>(key: string, available: readonly T[]): Ref<T> {
  let initial = available[0];
  try {
    const saved = localStorage.getItem(key) as T | null;
    if (saved && available.includes(saved)) initial = saved;
  } catch {
    // 忽略：只是少了记忆
  }
  const source = ref(initial) as Ref<T>;
  watch(source, (value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // 忽略
    }
  });
  return source;
}

export const useCollectDialogsStore = defineStore("collectDialogs", () => {
  /** 当前打开的是哪个对话框（同时只开一个） */
  const openGroup = ref<CollectGroup | null>(null);
  const localSource = rememberedSource<LocalSource>(LOCAL_SOURCE_KEY, LOCAL_SOURCES);
  const networkSource = rememberedSource<NetworkSource>(NETWORK_SOURCE_KEY, NETWORK_SOURCES);
  /** 「再次执行」带来的初始参数：只在那一次打开时生效，普通打开清空 */
  const localImportInitial = ref<LocalImportInitialConfig | undefined>(undefined);
  const webpageInitial = ref<WebpageCollectInitialConfig | undefined>(undefined);
  /** 每次打开 +1：宿主据此重新挂载面板，每次打开都从干净的草稿开始 */
  const openSeq = ref(0);
  /** 「选择收集方式」层（桌面对话框 / 紧凑档 picker） */
  const chooserOpen = ref(false);
  /** 紧凑档的本地导入：系统媒体选择器（图片 / 视频 / 文件夹） */
  const mediaPickerOpen = ref(false);

  /** 入口埋点（只在 Web 上报），事件名沿用画廊时期的 */
  function trackEntry(entry: string, from?: string) {
    if (!IS_WEB) return;
    trackEvent("gallery_import_entry", { url: currentUrl(), entry, ...(from ? { source: from } : {}) });
  }

  /**
   * 从入口打开某一组，来源停在上次打开的那个。紧凑档的「本地」是系统媒体选择器，不是对话框。
   * `from` 只用于埋点（页头不带，空状态 / picker 带）。
   */
  function enter(group: CollectGroup, from?: string) {
    if (!COLLECT_GROUPS.includes(group)) return;
    trackEntry(group, from);
    chooserOpen.value = false;
    if (group === "network") {
      openNetwork();
    } else if (useUiStore().isCompact) {
      mediaPickerOpen.value = true;
    } else {
      openLocal();
    }
  }

  /** 先让用户选本地 / 网络；只有一组时直接打开 */
  function openChooser(from: string) {
    if (COLLECT_GROUPS.length === 1) {
      enter(COLLECT_GROUPS[0]!, from);
      return;
    }
    trackEntry(from);
    chooserOpen.value = true;
  }

  /** 打开「本地」；不给来源时停在上次的来源 */
  function openLocal(source?: LocalSource, initial?: LocalImportInitialConfig) {
    if (!LOCAL_SOURCES.length) return;
    if (source && LOCAL_SOURCES.includes(source)) localSource.value = source;
    localImportInitial.value = initial;
    openSeq.value++;
    openGroup.value = "local";
  }

  /** 打开「网络」；插件来源的参数由调用方先 `writeTaskConfig(...)` 写进全局 taskConfig */
  function openNetwork(source?: NetworkSource, initial?: WebpageCollectInitialConfig) {
    if (source && NETWORK_SOURCES.includes(source)) networkSource.value = source;
    webpageInitial.value = initial;
    openSeq.value++;
    openGroup.value = "network";
  }

  function close() {
    openGroup.value = null;
  }

  return {
    openGroup,
    localSource,
    networkSource,
    localImportInitial,
    webpageInitial,
    openSeq,
    chooserOpen,
    mediaPickerOpen,
    enter,
    openChooser,
    openLocal,
    openNetwork,
    close,
  };
});
