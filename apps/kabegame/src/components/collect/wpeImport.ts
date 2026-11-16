import { i18n } from "@kabegame/i18n";
import { useCrawlerStore } from "@/stores/crawler";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import { kameMessage } from "@/utils/kameMessage";

/**
 * 提交一个内建 wpe-import 任务（「本地 → WPE 壁纸」与「网络 → Steam」共用）。
 * 成功返回 true 并提示；失败已提示，返回 false。
 */
export async function addWpeImportTask(
  userConfig: Record<string, unknown>,
  outputAlbumId: string | null,
  isDryRun: boolean,
): Promise<boolean> {
  if (await guardDesktopOnly("localImport", { needSuper: true })) return false;
  const t = i18n.global.t;
  const added = await useCrawlerStore().addTask(
    "wpe-import",
    undefined,
    userConfig,
    outputAlbumId ?? undefined,
    undefined,
    undefined,
    "manual",
    undefined,
    isDryRun,
  );
  if (!added) {
    kameMessage.error(t("gallery.wpeTaskFailed"));
    return false;
  }
  kameMessage.success(t("gallery.wpeTaskAdded"));
  return true;
}
