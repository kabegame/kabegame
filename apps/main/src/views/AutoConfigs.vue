<template>
  <div class="auto-configs-container">
    <TaskLogDialog ref="taskLogDialogRef" />
    <PageHeader :title="$t('autoConfig.tabTitle')" :show="headerShowFeatures" :fold="[]" sticky
      @action="handleHeaderAction">
      <template #subtitle>
        <span>{{ headerSubtitle }}</span>
      </template>
      <template #extra>
        <el-button type="primary" @click="goCreate">
          {{ $t("autoConfig.create") }}
        </el-button>
      </template>
    </PageHeader>

    <el-tabs v-model="listTab" class="auto-configs-list-tabs" @tab-change="onTabChange">
      <el-tab-pane name="mine" :label="$t('autoConfig.tabMine')">
        <div class="auto-configs-mine-pane">
          <div class="auto-configs-browse-toolbar" role="toolbar">
            <el-dropdown trigger="click" @command="onScheduleFilterCommand">
              <el-button class="auto-configs-browse-btn">
                <el-icon class="auto-configs-browse-icon">
                  <Timer />
                </el-icon>
                <span>{{ scheduleFilterButtonLabel }}</span>
                <el-icon class="el-icon--right">
                  <ArrowDown />
                </el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="all" :class="{ 'is-active': !onlyEnabled }">
                    {{ $t("gallery.filterAll") }}
                    <span class="plugin-count">({{ scheduleMenuAllCount }})</span>
                  </el-dropdown-item>
                  <el-dropdown-item command="enabled" :class="{ 'is-active': onlyEnabled }">
                    {{ $t("autoConfig.onlyEnabled") }}
                    <span class="plugin-count">({{ scheduleMenuEnabledCount }})</span>
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>

            <el-dropdown trigger="click" @command="onPluginFilterCommand">
              <el-button class="auto-configs-browse-btn">
                <el-icon class="auto-configs-browse-icon">
                  <Filter />
                </el-icon>
                <span>{{ pluginFilterButtonLabel }}</span>
                <el-icon class="el-icon--right">
                  <ArrowDown />
                </el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="" :class="{ 'is-active': !filterPluginId }">
                    {{ $t("autoConfig.filterPluginAll") }}
                    <span class="plugin-count">({{ pluginMenuAllCount }})</span>
                  </el-dropdown-item>
                  <el-dropdown-item v-for="row in pluginFilterRows" :key="row.pluginId" :command="row.pluginId"
                    :class="{ 'is-active': filterPluginId === row.pluginId }">
                    {{ pluginName(row.pluginId) }}
                    <span class="plugin-count">({{ row.count }})</span>
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>

          <div v-if="filteredConfigs.length === 0" class="auto-configs-empty">
            <el-empty :description="$t('autoConfig.noConfigs')">
              <p class="empty-hint">{{ $t("autoConfig.emptyHint") }}</p>
              <el-button type="primary" @click="goCreate">{{ $t("autoConfig.create") }}</el-button>
            </el-empty>
          </div>

          <div v-else class="auto-configs-vlist-wrap">
            <div v-bind="configListContainerProps" class="auto-configs-vlist-scroll">
              <div v-bind="configListWrapperProps">
                <div v-for="item in virtualConfigRows" :key="item.data.id" class="auto-configs-vrow"
                  :style="{ height: `${configListItemHeightPx}px` }">
                  <AutoConfigListCard class="auto-configs-vrow-card" :config="item.data" :variant="configCardVariant"
                    :schedule-toggling-id="scheduleTogglingId"
                    @card-click="(cfg) => autoConfigDialog.openExisting(cfg.id, 'view')"
                    @open-view="(id: string) => autoConfigDialog.openExisting(id, 'view')"
                    @schedule-enabled="handleScheduleEnabled" @run-now="handleRunNow" @more-command="handleMoreCommand"
                    @open-task-images="openTaskImages" @open-task-log="openTaskLog" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane name="recommended" :label="recommendedTabLabel">
        <div class="auto-configs-recommended-pane">
          <div v-if="recommendedGrouped.length === 0" class="auto-configs-empty auto-configs-empty--recommended">
            <el-empty :description="$t('autoConfig.noRecommendedConfigs')">
              <el-button type="primary" @click="goPluginBrowser">{{ $t("autoConfig.goToPluginStore") }}</el-button>
            </el-empty>
          </div>
          <div v-else class="auto-configs-recommended">
            <el-collapse v-model="activeRecommendedPluginId" accordion class="recommended-plugin-collapse">
              <el-collapse-item v-for="group in recommendedGrouped" :key="group.pluginId" :name="group.pluginId"
                class="recommended-plugin-block">
                <template #title>
                  <div class="recommended-plugin-title">
                    <div class="plugin-icon-frame recommended-plugin-icon-frame"
                      :class="{ 'plugin-icon-frame--placeholder': !pluginIconUrl(group.pluginId) }">
                      <img v-if="pluginIconUrl(group.pluginId)" class="plugin-icon-img"
                        :src="pluginIconUrl(group.pluginId)" alt="" />
                      <el-icon v-else :size="18" class="plugin-icon-fallback">
                        <AlarmClock />
                      </el-icon>
                    </div>
                    <span class="recommended-plugin-name">{{ pluginName(group.pluginId) }}</span>
                    <span class="recommended-plugin-count">({{ group.presets.length }})</span>
                  </div>
                </template>
                <div class="recommended-presets">
                  <el-card v-for="preset in group.presets" :key="preset.filename" class="recommended-preset-card"
                    shadow="hover">
                    <div class="recommended-preset-head">
                      <span class="recommended-preset-name">{{ resolvePresetTitle(preset) }}</span>
                      <div class="recommended-preset-actions">
                        <el-button size="small" @click="openPresetPreview(preset)">
                          {{ $t("autoConfig.viewRecommendedDetail") }}
                        </el-button>
                        <el-button type="primary" size="small" @click="importPreset(preset)">
                          {{ $t("autoConfig.importRecommended") }}
                        </el-button>
                      </div>
                    </div>
                    <p v-if="resolvePresetDesc(preset)" class="recommended-preset-desc">
                      {{ resolvePresetDesc(preset) }}
                    </p>
                  </el-card>
                </div>
              </el-collapse-item>
            </el-collapse>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="presetPreviewVisible" :title="$t('autoConfig.recommendedPreviewTitle')"
      class="auto-config-dialog task-params-dialog auto-config-preset-preview-dialog" width="min(560px, 92vw)"
      destroy-on-close append-to-body>
      <AutoConfigDetailContent v-if="presetPreviewRunConfig" :config="presetPreviewRunConfig"
        :show-schedule-last-run="false" />
      <template #footer>
        <el-button @click="presetPreviewVisible = false">{{ $t("common.cancel") }}</el-button>
        <el-button v-if="presetPreviewTarget" type="primary"
          @click="importPreset(presetPreviewTarget); presetPreviewVisible = false">
          {{ $t("autoConfig.importRecommended") }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="scheduleHelpVisible" :title="$t('autoConfig.scheduleHelpTitle')"
      class="auto-config-dialog task-params-dialog auto-config-schedule-help-dialog" width="min(480px, 92vw)"
      destroy-on-close append-to-body>
      <p class="acd-schedule-help-p">{{ $t("autoConfig.scheduleHelpP1") }}</p>
      <p class="acd-schedule-help-p">{{ $t("autoConfig.scheduleHelpP2") }}</p>
      <p class="acd-schedule-help-p">{{ $t("autoConfig.scheduleHelpP3") }}</p>
      <template #footer>
        <el-button type="primary" @click="scheduleHelpVisible = false">{{ $t("common.ok") }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="recommendedHelpVisible" :title="$t('autoConfig.recommendedHelpTitle')"
      class="auto-config-dialog task-params-dialog auto-config-recommended-help-dialog" width="min(480px, 92vw)"
      destroy-on-close append-to-body>
      <p class="acd-schedule-help-p">{{ $t("autoConfig.recommendedHelpP1") }}</p>
      <p class="acd-schedule-help-p">{{ $t("autoConfig.recommendedHelpP2") }}</p>
      <template #footer>
        <el-button type="primary" @click="recommendedHelpVisible = false">{{ $t("common.ok") }}</el-button>
      </template>
    </el-dialog>

    <!-- 安卓不显示这个页面，所以不做判断.收集（与画廊页一致：桌面 CrawlerDialog / 本地导入；安卓 CollectSourcePicker / drawer / MediaPicker） -->
    <CrawlerDialog v-model="showCrawlerDialog" :initial-config="crawlerDialogInitialConfig" />
    <LocalImportDialog v-model="showLocalImportDialog" />

    <!-- <CollectSourcePicker v-if="IS_ANDROID" v-model="showCollectSourcePicker" @select="handleCollectSourceSelect" /> -->
    <!-- <MediaPicker v-if="IS_ANDROID" v-model="showMediaPicker" @select="handleMediaPickerSelect" /> -->
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useVirtualList } from "@vueuse/core";
import { ElMessage, ElMessageBox } from "element-plus";
import { AlarmClock, ArrowDown, Filter, Timer } from "@element-plus/icons-vue";
import { useI18n, resolveConfigText } from "@kabegame/i18n";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import AutoConfigDetailContent from "@kabegame/core/components/scheduler/AutoConfigDetailContent.vue";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { IS_ANDROID } from "@kabegame/core/env";
import TaskLogDialog from "@kabegame/core/components/task/TaskLogDialog.vue";
import AutoConfigListCard from "@/components/scheduler/AutoConfigListCard.vue";
import CrawlerDialog from "@/components/CrawlerDialog.vue";
import LocalImportDialog from "@/components/LocalImportDialog.vue";
import { HeaderFeatureId } from "@kabegame/core/stores/header";
import { useCrawlerStore } from "@/stores/crawler";
import { useCrawlerDrawerStore } from "@/stores/crawlerDrawer";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { usePluginStore } from "@/stores/plugins";
import { useAutoConfigDialogStore } from "@/stores/autoConfigDialog";
import { checkRecommendedPresetCompatibility } from "@/composables/useConfigCompatibility";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import type { PluginRecommendedPreset, RunConfig } from "@kabegame/core/stores/crawler";

const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const crawlerStore = useCrawlerStore();
const crawlerDrawerStore = useCrawlerDrawerStore();
const quickSettingsDrawer = useQuickSettingsDrawerStore();
const autoConfigDialog = useAutoConfigDialogStore();
const pluginStore = usePluginStore();

const headerShowFeatures = [
  HeaderFeatureId.QuickSettings,
  HeaderFeatureId.TaskDrawer,
  HeaderFeatureId.Collect,
  HeaderFeatureId.Help,
];

const showCrawlerDialog = ref(false);
const showLocalImportDialog = ref(false);
const showMediaPicker = ref(false);
const showCollectSourcePicker = ref(false);
const crawlerDialogInitialConfig = ref<{
  pluginId?: string;
  outputDir?: string;
  vars?: Record<string, any>;
} | undefined>(undefined);

const onlyEnabled = ref(false);
const filterPluginId = ref<string | null>(null);
/** 正在切换 scheduleEnabled 的配置 id，避免重复点击 */
const scheduleTogglingId = ref<string | null>(null);
const taskLogDialogRef = ref<InstanceType<typeof TaskLogDialog> | null>(null);

const listTab = ref<"mine" | "recommended">("mine");
const activeRecommendedPluginId = ref("");
const presetPreviewVisible = ref(false);
const presetPreviewTarget = ref<PluginRecommendedPreset | null>(null);
const scheduleHelpVisible = ref(false);
const recommendedHelpVisible = ref(false);

if (IS_ANDROID) {
  useModalBack(presetPreviewVisible);
  useModalBack(scheduleHelpVisible);
  useModalBack(recommendedHelpVisible);
}

const presetPreviewRunConfig = computed((): RunConfig | null => {
  const preset = presetPreviewTarget.value;
  if (!preset) return null;
  const descRaw = preset.description;
  const descStr =
    descRaw != null && descRaw !== ""
      ? resolveConfigText(descRaw as any, locale.value).trim() || undefined
      : undefined;
  return {
    id: `preset:${preset.pluginId}:${preset.filename}`,
    name: preset.name as any,
    description: descStr,
    pluginId: preset.pluginId,
    url: preset.baseUrl || "",
    userConfig: preset.userConfig,
    httpHeaders: preset.httpHeaders,
    createdAt: 0,
    scheduleEnabled: !!preset.scheduleSpec,
    scheduleSpec: preset.scheduleSpec,
    schedulePlannedAt: undefined,
    scheduleLastRunAt: undefined,
    outputDir: undefined,
  };
});

const recommendedTabLabel = computed(() =>
  t("autoConfig.tabRecommendedWithCount", {
    n: crawlerStore.pluginRecommendedConfigs.length,
  }),
);

const recommendedGrouped = computed(() => {
  const map = new Map<string, PluginRecommendedPreset[]>();
  for (const p of crawlerStore.pluginRecommendedConfigs) {
    const arr = map.get(p.pluginId) ?? [];
    arr.push(p);
    map.set(p.pluginId, arr);
  }
  return [...map.entries()]
    .map(([pluginId, presets]) => ({
      pluginId,
      presets: presets.sort((a, b) => a.filename.localeCompare(b.filename)),
    }))
    .sort((a, b) =>
      pluginStore.pluginLabel(a.pluginId).localeCompare(pluginStore.pluginLabel(b.pluginId)),
    );
});

function resolvePresetTitle(preset: PluginRecommendedPreset) {
  const s = resolveConfigText(preset.name as any, locale.value).trim();
  return s || preset.filename;
}

function resolvePresetDesc(preset: PluginRecommendedPreset) {
  if (preset.description == null || preset.description === "") return "";
  return resolveConfigText(preset.description as any, locale.value).trim();
}

function openPresetPreview(preset: PluginRecommendedPreset) {
  presetPreviewTarget.value = preset;
  presetPreviewVisible.value = true;
}

async function importPreset(preset: PluginRecommendedPreset) {
  if (await guardDesktopOnly("importRecommendedConfig", { needSuper: true })) return;
  const compat = await checkRecommendedPresetCompatibility(preset.pluginId, preset.userConfig);
  if (!compat.versionCompatible) {
    ElMessage.error(compat.versionReason ?? t("common.pluginNotExist"));
    return;
  }
  if (!compat.contentCompatible) {
    try {
      await ElMessageBox.confirm(
        [...compat.contentErrors, ...compat.warnings].join("\n"),
        t("autoConfig.importCompatibilityWarningTitle"),
        {
          type: "warning",
          confirmButtonText: t("autoConfig.importContinue"),
          cancelButtonText: t("common.cancel"),
        },
      );
    } catch {
      return;
    }
  }
  try {
    await crawlerStore.importRecommendedPreset(preset);
    ElMessage.success(t("autoConfig.importRecommendedSuccess"));
    listTab.value = "mine";
  } catch (e) {
    console.error(e);
    ElMessage.error(t("common.operationFailed"));
  }
}

watch(
  recommendedGrouped,
  (groups) => {
    if (groups.length === 0) {
      activeRecommendedPluginId.value = "";
      return;
    }
    const exists = groups.some((group) => group.pluginId === activeRecommendedPluginId.value);
    if (!exists) {
      activeRecommendedPluginId.value = groups[0]?.pluginId ?? "";
    }
  },
  { immediate: true },
);

watch(
  () => route.query.tab,
  (tab) => {
    listTab.value = tab === "recommended" ? "recommended" : "mine";
  },
  { immediate: true },
);

function onTabChange(name: string | number) {
  const tab = String(name);
  const q = { ...route.query } as Record<string, string | string[]>;
  if (tab === "recommended") q.tab = "recommended";
  else delete q.tab;
  void router.replace({ path: route.path, query: q });
}

onMounted(async () => {
  await crawlerStore.runConfigsReady;
});

function goPluginBrowser() {
  void router.push({ name: "PluginBrowser" });
}

const configs = computed(() => crawlerStore.runConfigs);

const filteredConfigs = computed(() => {
  let list = configs.value;
  if (filterPluginId.value) {
    list = list.filter((c) => c.pluginId === filterPluginId.value);
  }
  if (onlyEnabled.value) {
    list = list.filter((c) => c.scheduleEnabled);
  }
  return list;
});

const configListItemHeightPx = IS_ANDROID
  ? 640
  : 312;

const configCardVariant = IS_ANDROID ? "android" : "desktop";

const {
  list: virtualConfigRows,
  containerProps: configListContainerProps,
  wrapperProps: configListWrapperProps,
} = useVirtualList(filteredConfigs, {
  itemHeight: configListItemHeightPx,
  overscan: 3,
});

/** 仅按插件过滤（用于「定时」下拉中的数量） */
const configsForScheduleMenu = computed(() => {
  if (!filterPluginId.value) return configs.value;
  return configs.value.filter((c) => c.pluginId === filterPluginId.value);
});

const scheduleMenuAllCount = computed(() => configsForScheduleMenu.value.length);
const scheduleMenuEnabledCount = computed(
  () => configsForScheduleMenu.value.filter((c) => c.scheduleEnabled).length,
);

/** 仅按定时开关过滤（用于「插件」下拉中的数量） */
const configsForPluginMenu = computed(() =>
  onlyEnabled.value ? configs.value.filter((c) => c.scheduleEnabled) : configs.value,
);

const pluginMenuAllCount = computed(() => configsForPluginMenu.value.length);

const pluginFilterRows = computed(() => {
  const map = new Map<string, number>();
  for (const c of configsForPluginMenu.value) {
    if (!c.pluginId) continue;
    map.set(c.pluginId, (map.get(c.pluginId) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([pluginId, count]) => ({ pluginId, count }))
    .sort((a, b) =>
      pluginStore.pluginLabel(a.pluginId).localeCompare(pluginStore.pluginLabel(b.pluginId)),
    );
});

const headerSubtitle = computed(() => {
  const total = configs.value.length;
  const shown = filteredConfigs.value.length;
  if (onlyEnabled.value || filterPluginId.value) {
    return t("autoConfig.listFiltered", { shown, total });
  }
  return t("autoConfig.listCount", { total });
});

const scheduleFilterButtonLabel = computed(() =>
  onlyEnabled.value ? t("autoConfig.onlyEnabled") : t("gallery.filterAll"),
);

const pluginFilterButtonLabel = computed(() =>
  filterPluginId.value ? pluginName(filterPluginId.value) : t("autoConfig.filterPluginAll"),
);

function onScheduleFilterCommand(cmd: string) {
  onlyEnabled.value = cmd === "enabled";
}

function onPluginFilterCommand(cmd: string) {
  filterPluginId.value = cmd ? cmd : null;
}

const pluginIconUrl = (pluginId: string) => pluginStore.pluginIconDataUrl(pluginId);

const openTaskImages = (taskId: string) => {
  void router.push({ name: "TaskDetail", params: { id: taskId } });
};

const openTaskLog = async (taskId: string) => {
  await taskLogDialogRef.value?.openTaskLog(taskId);
};

const pluginName = (pluginId: string) => pluginStore.pluginLabel(pluginId);

const goCreate = () => {
  autoConfigDialog.openCreate();
};

const handleCollectSourceSelect = (source: "local" | "remote") => {
  showCollectSourcePicker.value = false;
  if (source === "local") {
    showMediaPicker.value = true;
  } else {
    crawlerDrawerStore.open();
  }
};

const handleDelete = async (id: string) => {
  if (await guardDesktopOnly("deleteRunConfig", { needSuper: true })) return;
  try {
    await ElMessageBox.confirm(t("autoConfig.confirmDelete"), t("autoConfig.delete"), {
      type: "warning",
      confirmButtonText: t("common.confirm"),
      cancelButtonText: t("common.cancel"),
    });
    await crawlerStore.deleteRunConfig(id);
    ElMessage.success(t("autoConfig.deleted"));
  } catch {
    // ignore cancel
  }
};

const handleCopy = async (id: string) => {
  await crawlerStore.copyRunConfig(id);
  ElMessage.success(t("autoConfig.copied"));
};

const handleRunNow = async (id: string) => {
  if (await guardDesktopOnly("runConfig", { needSuper: true })) return;
  const ok = await crawlerStore.runFromConfig(id);
  if (ok) {
    ElMessage.success(t("autoConfig.runNowSuccess"));
  }
};

const handleMoreCommand = (cmd: string, cfg: RunConfig) => {
  switch (cmd) {
    case "edit":
      autoConfigDialog.openExisting(cfg.id, "edit");
      break;
    case "copy":
      void handleCopy(cfg.id);
      break;
    case "delete":
      void handleDelete(cfg.id);
      break;
    default:
      break;
  }
};

const handleScheduleEnabled = async (cfg: RunConfig, enabled: boolean) => {
  if (cfg.scheduleEnabled === enabled || scheduleTogglingId.value === cfg.id) return;
  scheduleTogglingId.value = cfg.id;
  try {
    if (enabled && !cfg.scheduleSpec?.mode) {
      const d = new Date();
      await crawlerStore.updateRunConfig({
        ...cfg,
        scheduleEnabled: true,
        scheduleSpec: {
          mode: "daily",
          hour: d.getHours(),
          minute: d.getMinutes(),
        },
      });
    } else {
      await crawlerStore.updateRunConfig({ ...cfg, scheduleEnabled: enabled });
    }
  } catch {
    ElMessage.error(t("common.operationFailed"));
  } finally {
    scheduleTogglingId.value = null;
  }
};

const handleHeaderAction = (payload: { id: string; data?: { type: string; value?: string } }) => {
  if (payload.id === HeaderFeatureId.Help) {
    if (listTab.value === "recommended") {
      recommendedHelpVisible.value = true;
    } else {
      scheduleHelpVisible.value = true;
    }
    return;
  }
  if (payload.id === HeaderFeatureId.QuickSettings) {
    quickSettingsDrawer.open("autoconfigs");
    return;
  }
  if (payload.id === HeaderFeatureId.Collect) {
    const d = payload.data;
    if (d?.type === "openMenu") {
      showCollectSourcePicker.value = true;
    } else if (d?.type === "select") {
      if (d.value === "local") {
        showLocalImportDialog.value = true;
      } else if (d.value === "network") {
        showCrawlerDialog.value = true;
      }
    }
  }
};
</script>

<style scoped lang="scss">
.auto-configs-container {
  height: 100%;
  padding: 20px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.auto-configs-list-tabs {
  margin-bottom: 0;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;

  :deep(.el-tabs__header) {
    flex-shrink: 0;
    margin-bottom: 12px;
  }

  :deep(.el-tabs__content) {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  :deep(.el-tab-pane) {
    height: 100%;
    overflow: hidden;
  }
}

.auto-configs-mine-pane {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.auto-configs-vlist-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.auto-configs-vlist-scroll {
  flex: 1;
  min-height: 0;
  width: 100%;
}

.auto-configs-vrow {
  flex-shrink: 0;
  box-sizing: border-box;
  width: 100%;
}

.auto-configs-vrow-card {
  height: calc(100% - 16px);
  margin-bottom: 16px;
  box-sizing: border-box;
}

.acd-schedule-help-p {
  margin: 0 0 12px;
  font-size: 14px;
  line-height: 1.55;
  color: var(--anime-text-secondary);
}

.acd-schedule-help-p:last-child {
  margin-bottom: 0;
}

.auto-configs-recommended {
  margin-top: 12px;
  padding: 4px 2px 8px;
}

.recommended-plugin-title {
  display: inline-flex;
  flex: 1;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding-right: 8px;
}

.recommended-plugin-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--anime-text-secondary);
}

.recommended-plugin-count {
  font-size: 13px;
  color: var(--anime-text-muted);
}

.recommended-plugin-icon-frame {
  width: 28px;
  height: 28px;
  border-radius: 8px;
}

.recommended-plugin-collapse {
  border: none;
  background: transparent;

  :deep(.el-collapse-item) {
    margin-bottom: 14px;
    border: 1px solid var(--anime-border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--el-bg-color);
  }

  :deep(.el-collapse-item:last-child) {
    margin-bottom: 0;
  }

  :deep(.el-collapse-item__header) {
    height: auto;
    min-height: 52px;
    padding: 14px 16px;
    line-height: 1.4;
    border-bottom: 1px solid transparent;
  }

  :deep(.el-collapse-item.is-active > .el-collapse-item__header) {
    border-bottom-color: var(--anime-border);
  }

  :deep(.el-collapse-item__wrap) {
    border-bottom: none;
    background: transparent;
  }

  :deep(.el-collapse-item__content) {
    padding: 14px 16px 18px;
    background: var(--el-fill-color-extra-light, var(--el-fill-color-light));
  }

  :deep(.el-collapse-item__arrow) {
    margin: 0 0 0 12px;
  }
}

.recommended-presets {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.recommended-preset-card.el-card {
  border-radius: 12px;
  border: 1px solid var(--anime-border);

  :deep(.el-card__body) {
    padding: 18px 20px;
  }
}

.recommended-preset-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px 16px;
}

.recommended-preset-name {
  font-weight: 600;
  font-size: 15px;
  line-height: 1.45;
  padding-top: 2px;
}

.recommended-preset-desc {
  margin: 14px 0 0;
  font-size: 13px;
  color: var(--anime-text-muted);
  line-height: 1.55;
}

.recommended-preset-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  flex-shrink: 0;
}

.auto-configs-browse-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 0;
  margin-bottom: 8px;
}

.auto-configs-browse-btn {
  .auto-configs-browse-icon {
    margin-right: 6px;
    font-size: 14px;
  }
}

:deep(.plugin-count) {
  margin-left: 4px;
  opacity: 0.75;
  font-size: 12px;
}

.auto-configs-empty {
  margin-top: 28px;

  .empty-hint {
    margin: 0 0 16px;
    max-width: 320px;
    margin-left: auto;
    margin-right: auto;
    font-size: 13px;
    line-height: 1.5;
    color: var(--anime-text-muted);
    text-align: center;
  }
}

.auto-configs-recommended-pane {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  box-sizing: border-box;
}

.recommended-plugin-title .plugin-icon-frame {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--el-fill-color-light);
  border: 1px solid var(--anime-border);
}

.recommended-plugin-title .plugin-icon-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.recommended-plugin-title .plugin-icon-fallback {
  color: var(--anime-text-secondary);
}
</style>
