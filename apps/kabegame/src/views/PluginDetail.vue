<template>
  <div class="plugin-detail flex flex-col h-full min-h-0">
    <PluginDetailPageHeader
      :plugin="plugin"
      :plugin-id="pluginIdRef"
      :is-remote="isRemote"
      @back="goBack"
      @install="handleInstall"
      @uninstall="handleUninstall"
      @copy-id="handleCopyPluginId"
    />

    <div class="detail-body flex-1 min-h-0">
      <PluginDetailContent
        :loading="loading"
        :show-skeleton="showSkeleton"
        :plugin="plugin"
        :is-remote="isRemote"
        @start-task="handleStartTask"
        @import-all-presets="handleImportAllPresets"
        @doc-image-preview-open="handleDocImagePreviewOpen"
        @doc-image-preview-close="handleDocImagePreviewClose"
      />
    </div>

    <!-- 桌面端「用此源新建任务」在本页开 CrawlerDialog；紧凑端走全局 crawlerDrawerStore -->
    <CrawlerDialog
      v-if="!isCompact"
      :model-value="crawlerDialog.isOpen.value"
      :initial-config="crawlerDialogInitialConfig"
      @update:model-value="crawlerDialog.close"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessageBox } from "element-plus";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";
import { invoke } from "@/api/rpc";
import { IS_WEB } from "@kabegame/core/env";
import { isUpdateAvailable } from "@kabegame/core/utils/version";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useModal } from "@kabegame/core/composables/useModal";
import { usePluginStore } from "@/stores/plugins";
import { useCrawlerStore, type PluginRecommendedPreset } from "@/stores/crawler";
import { useCrawlerDrawerStore } from "@/stores/crawlerDrawer";
import { checkRecommendedPresetCompatibility } from "@/composables/useConfigCompatibility";
import { trackEvent } from "@kabegame/core/track/umami";
import PluginDetailContent from "@kabegame/core/components/plugin/PluginDetailContent.vue";
import PluginDetailPageHeader from "@/components/header/PluginDetailPageHeader.vue";
import CrawlerDialog from "@/components/CrawlerDialog.vue";
import { usePluginDetailLoader } from "@/composables/usePluginDetailLoader";

const { t } = useI18n();
const { pluginName } = usePluginManifestI18n();
const route = useRoute();
const router = useRouter();
const pluginStore = usePluginStore();
const crawlerStore = useCrawlerStore();
const crawlerDrawerStore = useCrawlerDrawerStore();
const uiStore = useUiStore();
const isCompact = computed(() => uiStore.isCompact);

// ---- 路由参数：/plugins/:pluginId?mode=remote&source=<sourceId>&version=<v> ----
const pluginIdRef = computed(() => (route.params.pluginId as string) || null);
const modeRef = computed<"local" | "remote">(() => (route.query.mode === "remote" ? "remote" : "local"));
const sourceIdRef = computed(() => (route.query.source as string) || null);
const expectedVersionRef = computed(() => (route.query.version as string) || null);
const isRemote = computed(() => modeRef.value === "remote");
const activeRef = computed(() => true);

const { plugin, loading, showSkeleton, reload } = usePluginDetailLoader({
  pluginId: pluginIdRef,
  mode: modeRef,
  sourceId: sourceIdRef,
  expectedVersion: expectedVersionRef,
  active: activeRef,
  onLoadFailure: () => goBack(),
});

const goBack = () => {
  if (window.history.length > 1) router.back();
  else void router.push({ name: "PluginBrowser" });
};

// 与页面头部同一套判据：决定确认弹窗与成功提示用「安装/更新/重新安装」哪一套文案
const installedMatch = computed(() => pluginStore.plugins.find((p) => p.id === plugin.value?.id) ?? null);
const isUpdateFlow = computed(
  () => !!installedMatch.value && !!plugin.value && isUpdateAvailable(installedMatch.value.version, plugin.value.version)
);
const isReinstallFlow = computed(() => !!installedMatch.value && !isUpdateFlow.value);

const handleInstall = async () => {
  if (!plugin.value || !isRemote.value || !sourceIdRef.value) return;

  const confirmTitle = isReinstallFlow.value
    ? t("plugins.confirmReinstall")
    : isUpdateFlow.value
      ? t("plugins.confirmUpdate")
      : t("plugins.confirmInstall");
  const successMsg = isReinstallFlow.value
    ? t("plugins.reinstallSuccess")
    : isUpdateFlow.value
      ? t("plugins.updateSuccess")
      : t("plugins.installSuccess");

  try {
    await ElMessageBox.confirm(t("plugins.installFromStoreConfirm", { name: pluginName(plugin.value) }), confirmTitle, {
      type: "warning",
      confirmButtonText: t("plugins.installButton"),
      cancelButtonText: t("common.cancel"),
    });

    await invoke("install_from_store", { sourceId: sourceIdRef.value, pluginId: pluginIdRef.value });
    ElMessage.success(successMsg);
    // plugin-added / plugin-updated 事件会自动刷新 pluginStore；装完切到本地视图看已装版本
    void router.replace({ name: "PluginDetail", params: { pluginId: pluginIdRef.value } });
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error(t("plugins.installUpdateFailed"));
    }
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
      goBack();
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

// ---- 新建任务 ----
const crawlerDialog = useModal();
const crawlerDialogInitialConfig = ref<
  { pluginId?: string; vars?: Record<string, any>; httpHeaders?: Record<string, string> } | undefined
>(undefined);

const handleStartTask = (payload: {
  pluginId: string;
  vars?: Record<string, any>;
  httpHeaders?: Record<string, string>;
}) => {
  if (isCompact.value) {
    crawlerDrawerStore.open({ pluginId: payload.pluginId, vars: payload.vars, httpHeaders: payload.httpHeaders });
    return;
  }
  crawlerDialogInitialConfig.value = {
    pluginId: payload.pluginId,
    vars: payload.vars,
    httpHeaders: payload.httpHeaders,
  };
  crawlerDialog.open();
};

// 关闭后清掉初始配置，避免下次开对话框复用上一次的值（与 Gallery.vue 同一处理）
watch(crawlerDialog.isOpen, (isOpen) => {
  if (!isOpen) void nextTick(() => (crawlerDialogInitialConfig.value = undefined));
});

const handleImportAllPresets = async (presets: PluginRecommendedPreset[]) => {
  let success = 0;
  let failed = 0;
  for (const preset of presets) {
    try {
      const compat = await checkRecommendedPresetCompatibility(preset.pluginId, preset.userConfig);
      if (!compat.versionCompatible) {
        failed++;
        continue;
      }
      await crawlerStore.importRecommendedPreset(preset);
      success++;
    } catch {
      failed++;
    }
  }
  if (failed > 0) {
    ElMessage.warning(t("plugins.detail.importAllPresetsPartial", { success, failed }));
  } else if (success > 0) {
    ElMessage.success(t("plugins.detail.importAllPresetsSuccess", { success }));
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

const handleDocImagePreviewOpen = (payload: { index: number; count: number; src: string; alt: string }) =>
  trackDocImageAction("previewOpen", payload);
const handleDocImagePreviewClose = (payload: { index: number; count: number; src: string; alt: string }) =>
  trackDocImageAction("previewClose", payload);

// 卸载后可能仍停在本页（比如返回栈只有这一页），插件数据变了要重拉
watch(
  () => pluginStore.plugins.length,
  () => {
    if (!isRemote.value) void reload();
  }
);
</script>

<style scoped>
.plugin-detail {
  /* 与其它详情页（TaskDetail / AlbumDetail）一致的四周留白 */
  padding: 16px;
}

.detail-body {
  border-radius: 12px;
  background: #fff;
  border: 1px solid var(--anime-border);
  overflow: hidden;
}
</style>
