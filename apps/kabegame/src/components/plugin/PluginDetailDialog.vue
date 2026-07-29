<template>
  <el-dialog
    :model-value="visible"
    :z-index="modal.zIndex.value"
    :title="title"
    :width="IS_ANDROID ? '100%' : '800px'"
    :top="IS_ANDROID ? '0' : '5vh'"
    :fullscreen="IS_ANDROID"
    append-to-body
    class="plugin-detail-dialog"
    :class="{ 'mobile-fullscreen': IS_ANDROID }"
    @update:model-value="modal.close"
  >
    <PluginDetailContent
      :title="title"
      :show-back="IS_ANDROID"
      :loading="loading"
      :show-skeleton="showSkeleton"
      :plugin="plugin"
      :installed="isInstalled"
      :installing="installing"
      :show-uninstall="true"
      :installing-text="t('plugins.installing')"
      :install-progress-percent="installProgressPercent"
      :app-version="appVersion"
      @back="modal.close"
      @install="handleInstall"
      @uninstall="handleUninstall"
      @copy-id="handleCopyPluginId"
      @doc-image-preview-open="handleDocImagePreviewOpen"
      @doc-image-preview-close="handleDocImagePreviewClose"
    />
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { ElMessageBox } from "element-plus";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";
import { invoke, listen } from "@/api/rpc";
import { IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import { useModal } from "@kabegame/core/composables/useModal";
import { useApp } from "@/stores/app";
import { usePluginStore } from "@/stores/plugins";
import { trackEvent } from "@kabegame/core/track/umami";
import PluginDetailContent from "@kabegame/core/components/plugin/PluginDetailContent.vue";
import { usePluginDetailLoader } from "@/composables/usePluginDetailLoader";

/** 与 PluginBrowser.vue 的 PluginListItem 对应：打开弹窗需要的最小定位信息 */
export interface PluginDetailDialogTarget {
  pluginId: string;
  mode: "local" | "remote";
  sourceId?: string | null;
  version?: string | null;
}

const props = defineProps<{
  visible: boolean;
  target: PluginDetailDialogTarget | null;
}>();

const emit = defineEmits<{
  (e: "update:visible", val: boolean): void;
}>();

const { t } = useI18n();
const { pluginName } = usePluginManifestI18n();
const pluginStore = usePluginStore();
const { version: appVersion } = storeToRefs(useApp());

const modal = useModal({ onClose: () => emit("update:visible", false) });
watch(() => props.visible, (v) => (v ? modal.open() : modal.close()), { immediate: true });

const pluginIdRef = computed(() => props.target?.pluginId ?? null);
const modeRef = computed<"local" | "remote">(() => props.target?.mode ?? "local");
const sourceIdRef = computed(() => props.target?.sourceId ?? null);
const expectedVersionRef = computed(() => props.target?.version ?? null);
const activeRef = computed(() => props.visible);

const { plugin, loading, showSkeleton, isInstalled, reload } = usePluginDetailLoader({
  pluginId: pluginIdRef,
  mode: modeRef,
  sourceId: sourceIdRef,
  expectedVersion: expectedVersionRef,
  active: activeRef,
  onLoadFailure: () => modal.close(),
});

const title = computed(() => (plugin.value ? pluginName(plugin.value) : "") || t("plugins.pluginDetailTitle"));

const installing = ref(false);
const installProgressPercent = ref<number | null>(null);
let unlistenProgress: (() => void) | undefined;

watch(
  () => props.visible,
  async (v) => {
    unlistenProgress?.();
    unlistenProgress = undefined;
    installProgressPercent.value = null;
    if (!v) return;
    try {
      const { isTauri } = await import("@tauri-apps/api/core");
      if (!isTauri()) return;
      unlistenProgress = await listen<{ sourceId: string; pluginId: string; percent: number; error?: string | null }>(
        "plugin-store-download-progress",
        (event) => {
          const { sourceId, pluginId, percent } = event.payload;
          if (sourceId !== sourceIdRef.value || pluginId !== pluginIdRef.value) return;
          installProgressPercent.value = percent;
        }
      );
    } catch {
      /* 无事件环境 */
    }
  },
  { immediate: true }
);

const handleInstall = async () => {
  if (!plugin.value || modeRef.value !== "remote" || !sourceIdRef.value) return;

  try {
    await ElMessageBox.confirm(
      t("plugins.installFromStoreConfirm", { name: pluginName(plugin.value) }),
      t("plugins.confirmInstall"),
      {
        type: "warning",
        confirmButtonText: t("plugins.installButton"),
        cancelButtonText: t("common.cancel"),
      }
    );

    installing.value = true;
    installProgressPercent.value = 0;
    await invoke("install_from_store", {
      sourceId: sourceIdRef.value,
      pluginId: pluginIdRef.value,
    });
    ElMessage.success(t("plugins.installSuccess"));
    // plugin-added / plugin-updated 事件会自动刷新 pluginStore
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error(t("plugins.installFailed"));
    }
  } finally {
    installing.value = false;
    installProgressPercent.value = null;
  }
};

const handleUninstall = async () => {
  if (!plugin.value) return;

  try {
    await ElMessageBox.confirm(t("plugins.confirmUninstall", { name: pluginName(plugin.value) }), t("plugins.confirmDelete"), {
      type: "warning",
    });

    const installed = pluginStore.plugins.find((p) => p.id === plugin.value!.id);
    if (installed) {
      await pluginStore.deletePlugin(installed.id);
      ElMessage.success(t("plugins.pluginDeleted"));
      pluginStore.clearPluginDetailCache();
      await reload();
    }
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error(t("plugins.uninstallFailed"));
    }
  }
};

const handleCopyPluginId = async (id?: string) => {
  const pluginId = id ?? plugin.value?.id;
  if (!pluginId) return;

  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    if (isTauri()) {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(pluginId);
    } else {
      await navigator.clipboard.writeText(pluginId);
    }
    ElMessage.success(t("plugins.pluginIdCopied"));
  } catch {
    ElMessage.error(t("plugins.copyFailed"));
  }
};

function currentUrl() {
  return typeof location === "undefined" ? "" : location.pathname + location.search;
}

function trackDocImageAction(
  command: "previewOpen" | "previewClose",
  payload: { index: number; count: number; src: string; alt: string }
) {
  if (!IS_WEB) return;
  trackEvent("plugin_detail_doc_image_action", {
    command,
    url: currentUrl(),
    pluginId: plugin.value?.id ?? pluginIdRef.value,
    pluginName: plugin.value ? pluginName(plugin.value) : pluginIdRef.value,
    mode: modeRef.value,
    sourceId: sourceIdRef.value,
    version: plugin.value?.version ?? expectedVersionRef.value,
    image: payload,
  });
}

const handleDocImagePreviewOpen = (payload: { index: number; count: number; src: string; alt: string }) => {
  trackDocImageAction("previewOpen", payload);
};
const handleDocImagePreviewClose = (payload: { index: number; count: number; src: string; alt: string }) => {
  trackDocImageAction("previewClose", payload);
};
</script>

<style>
.plugin-detail-dialog {
  display: flex;
  flex-direction: column;
}

.plugin-detail-dialog.mobile-fullscreen {
  margin: 0 !important;
}

.plugin-detail-dialog.mobile-fullscreen .el-dialog {
  margin: 0 !important;
  max-height: 100vh !important;
  height: 100vh !important;
  border-radius: 0 !important;
}

.plugin-detail-dialog.mobile-fullscreen .el-dialog__body {
  padding: 0 !important;
  height: calc(100vh - 60px) !important;
}

.plugin-detail-dialog .el-dialog {
  display: flex;
  flex-direction: column;
  max-height: 90vh;
  margin: 5vh auto;
}

.plugin-detail-dialog .el-dialog__body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}
</style>
