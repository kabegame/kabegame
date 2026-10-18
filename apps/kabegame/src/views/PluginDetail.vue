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
        :initial-vars="initialVars"
        @start-task="handleStartTask"
        @import-all-presets="handleImportAllPresets"
        @doc-image-preview-open="handleDocImagePreviewOpen"
        @doc-image-preview-close="handleDocImagePreviewClose"
      />
    </div>

    <el-dialog
      :model-value="installConfirmDialog.isOpen.value"
      :z-index="installConfirmDialog.zIndex.value"
      :title="installConfirmTitle"
      width="min(420px, 92vw)"
      append-to-body
      :close-on-click-modal="false"
      :close-on-press-escape="!installing"
      :show-close="!installing"
      @update:model-value="(value) => !value && !installing && installConfirmDialog.close()"
    >
      <div class="flex items-start gap-3 leading-6 text-[var(--anime-text-secondary)]">
        <el-icon :size="24" class="mt-0.5 flex-none text-[var(--el-color-warning)]">
          <WarningFilled />
        </el-icon>
        <span>{{ installConfirmMessage }}</span>
      </div>
      <template #footer>
        <el-button :disabled="installing" @click="installConfirmDialog.close()">{{ t("common.cancel") }}</el-button>
        <el-button type="primary" :loading="installing" @click="confirmInstall">
          {{ t("plugins.installButton") }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      :model-value="uninstallConfirmDialog.isOpen.value"
      :z-index="uninstallConfirmDialog.zIndex.value"
      :title="t('plugins.confirmDelete')"
      width="min(420px, 92vw)"
      append-to-body
      :close-on-click-modal="false"
      :close-on-press-escape="!uninstalling"
      :show-close="!uninstalling"
      @update:model-value="(value) => !value && !uninstalling && uninstallConfirmDialog.close()"
    >
      <div class="flex items-start gap-3 leading-6 text-[var(--anime-text-secondary)]">
        <el-icon :size="24" class="mt-0.5 flex-none text-[var(--el-color-warning)]">
          <WarningFilled />
        </el-icon>
        <span>{{ uninstallConfirmMessage }}</span>
      </div>
      <template #footer>
        <el-button :disabled="uninstalling" @click="uninstallConfirmDialog.close()">
          {{ t("common.cancel") }}
        </el-button>
        <el-button type="danger" :loading="uninstalling" @click="confirmUninstall">
          {{ t("plugins.uninstall") }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { WarningFilled } from "@kabegame/element-plus-icons";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";
import { invoke } from "@/api/rpc";
import { IS_WEB } from "@/env";
import { isUpdateAvailable } from "@/utils/version";
import { usePluginStore } from "@/stores/plugins";
import { useCrawlerStore, type PluginRecommendedPreset } from "@/stores/crawler";
import { checkRecommendedPresetCompatibility } from "@/composables/useConfigCompatibility";
import { usePluginConfig } from "@/composables/usePluginConfig";
import { guardPluginPlatform, enqueueTask } from "@/composables/useCrawlTaskLauncher";
import { trackEvent } from "@/track/umami";
import { formatBytes } from "@/utils/formatBytes";
import PluginDetailContent from "@/components/plugin/PluginDetailContent.vue";
import PluginDetailPageHeader from "@/components/header/PluginDetailPageHeader.vue";
import { usePluginDetailLoader } from "@/composables/usePluginDetailLoader";
import { useModal } from "@/composables/useModal";

const { t } = useI18n();
const { pluginName } = usePluginManifestI18n();
const route = useRoute();
const router = useRouter();
const pluginStore = usePluginStore();
const crawlerStore = useCrawlerStore();

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
  else
    void router.push({
      name: "PluginBrowser",
      // 无历史可回（如直接打开详情链接）：远程条目回到它所属的商店 tab
      query: isRemote.value && sourceIdRef.value ? { tab: `store:${sourceIdRef.value}` } : {},
    });
};

// 与页面头部同一套判据：决定确认弹窗与成功提示用「安装/更新/重新安装」哪一套文案
const installedMatch = computed(() => pluginStore.plugins.find((p) => p.id === plugin.value?.id) ?? null);
const isUpdateFlow = computed(
  () =>
    !!installedMatch.value && !!plugin.value && isUpdateAvailable(installedMatch.value.version, plugin.value.version),
);
const isReinstallFlow = computed(() => !!installedMatch.value && !isUpdateFlow.value);

const installConfirmDialog = useModal();
const installing = ref(false);
const installConfirmTitle = computed(() =>
  isReinstallFlow.value
    ? t("plugins.confirmReinstall")
    : isUpdateFlow.value
      ? t("plugins.confirmUpdate")
      : t("plugins.confirmInstall"),
);
const installConfirmMessage = computed(() =>
  plugin.value
    ? t("plugins.installFromStoreConfirm", {
        name: pluginName(plugin.value),
        size: formatBytes(plugin.value.sizeBytes),
      })
    : "",
);

const handleInstall = () => {
  if (!plugin.value || !isRemote.value || !sourceIdRef.value) return;
  installConfirmDialog.open();
};

const confirmInstall = async () => {
  const sourceId = sourceIdRef.value;
  const targetPluginId = pluginIdRef.value;
  if (!plugin.value || !isRemote.value || !sourceId || !targetPluginId || installing.value) return;

  const successMsg = isReinstallFlow.value
    ? t("plugins.reinstallSuccess")
    : isUpdateFlow.value
      ? t("plugins.updateSuccess")
      : t("plugins.installSuccess");

  installing.value = true;
  try {
    await invoke("install_from_store", { sourceId, pluginId: targetPluginId });
    installConfirmDialog.close();
    ElMessage.success(successMsg);
    // plugin-added / plugin-updated 事件会自动刷新 pluginStore；保留当前商店详情与滚动位置。
  } catch {
    ElMessage.error(t("plugins.installUpdateFailed"));
  } finally {
    installing.value = false;
  }
};

const uninstallConfirmDialog = useModal();
const uninstalling = ref(false);
const uninstallConfirmMessage = computed(() =>
  plugin.value ? t("plugins.confirmUninstall", { name: pluginName(plugin.value) }) : "",
);

const handleUninstall = () => {
  if (!plugin.value) return;
  uninstallConfirmDialog.open();
};

const confirmUninstall = async () => {
  const targetPluginId = plugin.value?.id;
  if (!targetPluginId || uninstalling.value) return;
  const installed = pluginStore.plugins.find((p) => p.id === targetPluginId);
  if (!installed) {
    uninstallConfirmDialog.close();
    return;
  }

  uninstalling.value = true;
  try {
    await pluginStore.deletePlugin(installed.id);
    uninstallConfirmDialog.close();
    ElMessage.success(t("plugins.pluginDeleted"));
    pluginStore.clearPluginDetailCache();
    // 当前本地详情已失效：直接替换为插件列表，避免叠加历史回退或返回到已删除详情。
    void router.replace({ name: "PluginBrowser" });
  } catch {
    ElMessage.error(t("plugins.uninstallFailed"));
  } finally {
    uninstalling.value = false;
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

// ---- 插件磁盘默认配置：非 remote 时预取，作为配置 tab 初值 + 起任务默认输出目录/请求头 ----
const { form: pluginConfigForm, loadPluginVars } = usePluginConfig();
const initialVars = ref<Record<string, any> | null>(null);
const defaultOutputDir = ref("");
const defaultHttpHeaders = ref<Record<string, string>>({});

watch(
  () => [plugin.value?.id, isRemote.value] as const,
  async ([id, remote]) => {
    if (!id || remote) {
      initialVars.value = null;
      defaultOutputDir.value = "";
      defaultHttpHeaders.value = {};
      return;
    }
    try {
      const { httpHeaders, outputDir } = await loadPluginVars(id);
      initialVars.value = { ...pluginConfigForm.value.vars };
      defaultOutputDir.value = outputDir;
      defaultHttpHeaders.value = httpHeaders;
    } catch (e) {
      // 读不到磁盘默认配置不该让配置 tab 空掉：留 null 让表单退化为各字段 default
      console.debug("读取插件默认配置失败（忽略，表单用字段 default）：", e);
      initialVars.value = null;
      defaultOutputDir.value = "";
      defaultHttpHeaders.value = {};
    }
  },
  { immediate: true },
);

// ---- 新建任务：配置 tab 已经是能直接填的表单，起任务即直接入队 ----
const handleStartTask = async (payload: {
  pluginId: string;
  vars?: Record<string, any>;
  httpHeaders?: Record<string, string>;
}) => {
  if (!(await guardPluginPlatform(payload.pluginId))) return;
  const added = await enqueueTask({
    pluginId: payload.pluginId,
    outputDir: defaultOutputDir.value || undefined,
    userConfig: payload.vars,
    httpHeaders: payload.httpHeaders ?? defaultHttpHeaders.value,
    triggerSource: "manual",
  });
  if (added) {
    ElMessage.success(t("plugins.detail.taskStarted"));
  }
};

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
  payload: { index: number; count: number; src: string; alt: string },
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
  },
);
</script>

<style scoped>
.plugin-detail {
  /* 与其它详情页（TaskDetail）一致的四周留白 */
  padding: 16px;
}

.detail-body {
  border-radius: 12px;
  background: #fff;
  border: 1px solid var(--anime-border);
  overflow: hidden;
}
</style>
