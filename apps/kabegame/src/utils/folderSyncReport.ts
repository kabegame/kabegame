// 本地文件夹同步结果的 toast 收敛点。
// 原先 Albums.vue / AlbumDetail.vue 各存一份逐字相同的副本，此处为唯一实现。
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { i18n } from "@kabegame/i18n";
import type { BatchSyncItem, FolderStatusState, SyncReport } from "@/api/syncLocalFolder";

const t = (key: string, named?: Record<string, unknown>) =>
  named ? i18n.global.t(key, named) : i18n.global.t(key);

const syncStatusSuffix = (state: FolderStatusState) =>
  state.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase());

export const reportSingleSyncResult = (report: SyncReport) => {
  if (report.skippedInFlight) {
    ElMessage.info(t("albums.localFolder.syncInFlight"));
    return;
  }

  // 取消由 folder-sync-finished 事件统一提示，见 reportBatchSyncResult 的同款注释。
  if (report.canceled) return;

  // 后端没扫任何文件，added/deleted/reimported 恒为 0，落进 success 分支会误报"同步完成 +0/-0/~0"
  if (report.skippedUnchanged) {
    ElMessage.info(t("albums.localFolder.syncSkippedUnchanged"));
    return;
  }

  if (report.status && report.status.state !== "ok") {
    ElMessage.warning(
      t(`albums.localFolder.status${syncStatusSuffix(report.status.state)}`, {
        message: report.status.message ?? "",
      }),
    );
    return;
  }

  ElMessage.success(
    t("albums.localFolder.syncDone", {
      added: report.added,
      deleted: report.deleted,
      reimported: report.reimported,
    }),
  );
};

export const reportBatchSyncResult = (results: BatchSyncItem[]) => {
  if (results.length === 0) return;

  const errors = results.filter((r) => r.err != null);
  const badStatus = results.filter(
    (r) => r.ok && r.ok.status && r.ok.status.state !== "ok",
  );
  const okResults = results.filter((r) => r.ok && (!r.ok.status || r.ok.status.state === "ok"));

  let added = 0;
  let deleted = 0;
  let reimported = 0;
  let skippedInFlight = 0;
  let skippedUnchanged = 0;
  for (const r of okResults) {
    if (!r.ok) continue;
    added += r.ok.added;
    deleted += r.ok.deleted;
    reimported += r.ok.reimported;
    if (r.ok.skippedInFlight) skippedInFlight++;
    if (r.ok.skippedUnchanged) skippedUnchanged++;
  }

  if (errors.length > 0) {
    console.warn("[local_folder] sync errors", errors);
    ElMessage.error(
      t("albums.localFolder.refreshSyncFailedSome", {
        count: errors.length,
        firstError: errors[0]?.err ?? "",
      }),
    );
    return;
  }

  // 取消的提示统一由 folder-sync-finished 事件发（services/folderSync.ts），这里静默收场，
  // 免得同一次取消弹两条。取消时 status 沿用上次的旧值，也不该落进 badStatus 分支。
  if (results.some((r) => r.ok?.canceled)) return;

  if (badStatus.length > 0) {
    console.warn("[local_folder] sync bad status", badStatus);
    ElMessage.warning(
      t("albums.localFolder.refreshSyncBadStatus", { count: badStatus.length }),
    );
    return;
  }

  // 复用 {skippedText} 插槽拼接两种后缀，省掉改 5 个 locale 的既有句子
  const skippedText =
    (skippedInFlight > 0
      ? t("albums.localFolder.refreshSyncSkippedSuffix", { skipped: skippedInFlight })
      : "") +
    (skippedUnchanged > 0
      ? t("albums.localFolder.refreshSyncUnchangedSuffix", { skipped: skippedUnchanged })
      : "");
  ElMessage.success(
    t("albums.localFolder.refreshSyncDone", {
      added,
      deleted,
      reimported,
      skippedText,
    }),
  );
};
