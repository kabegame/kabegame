import { defineStore } from "pinia";
import { computed, ref } from "vue";

/** 单个 GitHub release 信息（对应后端 `ReleaseInfo`，serde camelCase）。 */
export interface ReleaseInfo {
  /** 带 v 前缀，如 v4.1.1。下载 URL 路径与展示均用它。 */
  tag: string;
  name: string;
  /** changelog markdown 原文（用 marked 渲染）。 */
  body: string;
  htmlUrl: string;
  publishedAt: string;
  assetUrl: string | null;
  assetName: string | null;
}

/** 状态机阶段，对齐后端 `UpdaterPhase`。`unchecked` 为瞬时锚点。 */
export type UpdaterPhase =
  | "unchecked"
  | "checking"
  | "checked"
  | "updateAvailable"
  | "downloading"
  | "restartable";

/** 后端 `UpdaterState` 完整快照（serde camelCase）。 */
export interface UpdaterState {
  phase: UpdaterPhase;
  currentVersion: string;
  platform: string;
  mode: string;
  arch: string;
  downloadable: boolean;
  releases: ReleaseInfo[];
  downloadedTag: string | null;
  downloadTag: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  lastDownloadError: string | null;
}

/** 下载进度事件载荷（`update-download-progress`）。 */
export interface DownloadProgress {
  tag: string;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number;
}

/**
 * 应用自动更新 store —— **后端权威状态的前端镜像**（不含状态机）。
 * 启动时 `get_updater_state` hydrate，之后靠 `updater-state-change` 等事件刷新。
 * 详见 `.claude/plans/desktop-auto-update/desktop-auto-update.md`。
 */
export const useUpdaterStore = defineStore("updater", () => {
  const phase = ref<UpdaterPhase>("unchecked");
  const currentVersion = ref("");
  const platform = ref("");
  const mode = ref("");
  const arch = ref("");
  const downloadable = ref(false);
  const releases = ref<ReleaseInfo[]>([]);
  const downloadedTag = ref<string | null>(null);
  const downloadTag = ref<string | null>(null);
  const downloadedBytes = ref(0);
  const totalBytes = ref<number | null>(null);
  const lastDownloadError = ref<string | null>(null);

  /** 更新弹窗（changelog tabs）是否打开。纯 UI 态。 */
  const dialogOpen = ref(false);

  const hasUpdate = computed(() => phase.value === "updateAvailable");
  const isChecking = computed(() => phase.value === "checking");
  const isDownloading = computed(() => phase.value === "downloading");
  /** restartable 期间若被瞬时 checking 覆盖，靠 downloadedTag 让「重启更新」按钮不闪走。 */
  const canShowRestart = computed(
    () => phase.value === "restartable" || downloadedTag.value != null,
  );
  /** checking / downloading 期间禁用「检查更新」「下载」入口。 */
  const busy = computed(() => phase.value === "checking" || phase.value === "downloading");
  const latestRelease = computed(() => releases.value[0] ?? null);
  const downloadPercent = computed(() => {
    const total = totalBytes.value ?? 0;
    if (total <= 0) return 0;
    return Math.min(100, Math.round((downloadedBytes.value / total) * 100));
  });

  /** 整体替换镜像（hydrate / `updater-state-change` 都走它）。 */
  function applyState(snap: UpdaterState) {
    phase.value = snap.phase;
    currentVersion.value = snap.currentVersion;
    platform.value = snap.platform;
    mode.value = snap.mode;
    arch.value = snap.arch;
    downloadable.value = snap.downloadable;
    releases.value = Array.isArray(snap.releases) ? snap.releases : [];
    downloadedTag.value = snap.downloadedTag ?? null;
    downloadTag.value = snap.downloadTag ?? null;
    downloadedBytes.value = snap.downloadedBytes ?? 0;
    totalBytes.value = snap.totalBytes ?? null;
    lastDownloadError.value = snap.lastDownloadError ?? null;
  }

  /** 仅更新进度三字段（高频事件，不替换整快照）。 */
  function applyProgress(p: DownloadProgress) {
    downloadedBytes.value = p.downloadedBytes ?? 0;
    totalBytes.value = p.totalBytes ?? null;
  }

  function setDownloadError(msg: string) {
    lastDownloadError.value = msg || null;
  }

  function openDialog() {
    dialogOpen.value = true;
  }
  function closeDialog() {
    dialogOpen.value = false;
  }

  return {
    phase,
    currentVersion,
    platform,
    mode,
    arch,
    downloadable,
    releases,
    downloadedTag,
    downloadTag,
    downloadedBytes,
    totalBytes,
    lastDownloadError,
    hasUpdate,
    isChecking,
    isDownloading,
    canShowRestart,
    busy,
    latestRelease,
    downloadPercent,
    dialogOpen,
    applyState,
    applyProgress,
    setDownloadError,
    openDialog,
    closeDialog,
  };
});
