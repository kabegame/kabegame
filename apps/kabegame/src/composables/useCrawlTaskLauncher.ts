import { IS_ANDROID } from "@/env";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import { useCrawlerStore, type CrawlTask } from "@/stores/crawler";
import { useBatteryOptimizationStore } from "@/stores/batteryOptimization";

/**
 * 起任务前置守卫：web 端拦截。Android 上 JS（WebView）插件与 V8 插件都可运行，不再按类型拒绝。
 * 返回 `false` 表示应中止。
 */
export async function guardPluginPlatform(): Promise<boolean> {
  if (await guardDesktopOnly("crawl", { needSuper: true })) return false;
  return true;
}

export interface EnqueueTaskParams {
  pluginId: string;
  outputDir?: string;
  userConfig?: Record<string, any>;
  outputAlbumId?: string;
  httpHeaders?: Record<string, string>;
  maxConcurrentDownloads?: number | null;
  runConfigId?: string;
  triggerSource?: CrawlTask["triggerSource"];
}

/**
 * 入队：Android 下先走电池优化检查，再调 `crawlerStore.addTask`。
 * 用具名参数对象接收，内部按 `addTask` 的真实参数顺序转发
 * （`outputAlbumId` 在 `httpHeaders` 之前，直接按位置传很容易传反）。
 */
export async function enqueueTask(params: EnqueueTaskParams): Promise<boolean> {
  if (IS_ANDROID) {
    const batteryOptimizationStore = useBatteryOptimizationStore();
    await batteryOptimizationStore.checkAndPromptIfNeeded();
  }

  const crawlerStore = useCrawlerStore();
  return await crawlerStore.addTask(
    params.pluginId,
    params.outputDir,
    params.userConfig,
    params.outputAlbumId,
    params.httpHeaders,
    params.runConfigId,
    params.triggerSource ?? "manual",
    params.maxConcurrentDownloads,
  );
}
