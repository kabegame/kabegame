import { IS_WEB } from "@/env";
import type { CrawlTask } from "@/stores/crawler";
import { LOCAL_IMPORT_PLUGIN_ID, WEBPAGE_PLUGIN_ID } from "@/stores/plugins";
import { useUiStore } from "@/stores/ui";
import { useCrawlerDrawerStore } from "@/stores/crawlerDrawer";
import { useCollectDialogsStore } from "@/stores/collectDialogs";
import { taskConfigFromTask, writeTaskConfig } from "@/composables/taskConfig";

/**
 * 任务「再次执行」：按任务参数回填对应的收集弹窗。
 * 抽屉右键菜单与任务详情页 header 共用。
 */
export function useTaskRerun() {
  const uiStore = useUiStore();
  const crawlerDrawerStore = useCrawlerDrawerStore();
  const collectDialogs = useCollectDialogsStore();

  const canRerun = (task: CrawlTask) => {
    if (task.pluginId === WEBPAGE_PLUGIN_ID) return !IS_WEB;
    if (task.pluginId === LOCAL_IMPORT_PLUGIN_ID) return !IS_WEB && !uiStore.isCompact;
    return true;
  };

  const rerunTask = async (task: CrawlTask) => {
    const userConfig = task.userConfig ?? {};
    if (task.pluginId === WEBPAGE_PLUGIN_ID) {
      collectDialogs.openWebpage({
        userConfig: { ...userConfig },
        outputDir: task.outputDir,
        httpHeaders: { ...(task.httpHeaders ?? {}) },
        outputAlbumId: task.outputAlbumId ?? null,
      });
      return;
    }
    if (task.pluginId === LOCAL_IMPORT_PLUGIN_ID) {
      collectDialogs.openLocalImport({
        paths: Array.isArray(userConfig.paths) ? [...userConfig.paths] : [],
        recursive: typeof userConfig.recursive === "boolean" ? userConfig.recursive : undefined,
        copyToDir: userConfig.copy_to_dir === true,
        outputDir: task.outputDir,
        outputAlbumId: task.outputAlbumId ?? null,
      });
      return;
    }
    // 通路 1：先把任务参数写进全局 taskConfig，再打开收集弹窗
    await writeTaskConfig(taskConfigFromTask(task));
    crawlerDrawerStore.open();
  };

  return { canRerun, rerunTask };
}
