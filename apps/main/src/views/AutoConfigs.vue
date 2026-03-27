<template>
  <div class="auto-configs-container">
    <TaskLogDialog ref="taskLogDialogRef" />
    <PageHeader
      :title="$t('autoConfig.tabTitle')"
      :show="[HeaderFeatureId.TaskDrawer, HeaderFeatureId.Help]"
      :fold="[]"
      sticky
      @action="handleHeaderAction"
    />

    <div class="auto-configs-toolbar" role="toolbar">
      <div class="toolbar-left">
        <el-switch v-model="onlyEnabled" />
        <span class="toolbar-label">{{ $t("autoConfig.onlyEnabled") }}</span>
      </div>
      <div class="toolbar-right">
        <span v-if="configs.length > 0" class="toolbar-count">{{ toolbarCountText }}</span>
        <el-button type="primary" @click="goCreate">
          {{ $t("autoConfig.create") }}
        </el-button>
      </div>
    </div>

    <div v-if="filteredConfigs.length === 0" class="auto-configs-empty">
      <el-empty :description="$t('autoConfig.noConfigs')">
        <p class="empty-hint">{{ $t("autoConfig.emptyHint") }}</p>
        <el-button type="primary" @click="goCreate">{{ $t("autoConfig.create") }}</el-button>
      </el-empty>
    </div>

    <div v-else class="auto-configs-list">
      <el-card
        v-for="cfg in filteredConfigs"
        :key="cfg.id"
        class="config-card"
        role="button"
        tabindex="0"
        @click="onConfigCardClick(cfg, $event)"
        @keydown.enter.prevent="autoConfigDialog.openExisting(cfg.id, 'view')"
        @keydown.space.prevent="autoConfigDialog.openExisting(cfg.id, 'view')"
      >
        <div class="config-card-grid">
          <div class="cg-icon" @click.stop>
            <div
              class="plugin-icon-frame"
              :class="{ 'plugin-icon-frame--placeholder': !pluginIconUrl(cfg.pluginId) }"
            >
              <img
                v-if="pluginIconUrl(cfg.pluginId)"
                class="plugin-icon-img"
                :src="pluginIconUrl(cfg.pluginId)"
                alt=""
              />
              <el-icon v-else :size="26" class="plugin-icon-fallback">
                <AlarmClock />
              </el-icon>
            </div>
            <el-switch
              class="schedule-enable-switch"
              size="small"
              :model-value="cfg.scheduleEnabled"
              :disabled="scheduleTogglingId === cfg.id"
              @update:model-value="(v: string | number | boolean) => handleScheduleEnabled(cfg, Boolean(v))"
            />
          </div>

          <div class="cg-main">
            <div class="config-title-line">
              <h3 class="config-name">{{ resolveText(cfg.name) }}</h3>
              <el-tag
                v-if="cfg.scheduleMode"
                class="config-mode-tag"
                type="primary"
                size="small"
                effect="plain"
              >
                {{ scheduleModeTitle(cfg) }}
              </el-tag>
              <el-tag
                v-else
                class="config-mode-tag"
                type="info"
                size="small"
                effect="plain"
              >
                {{ $t("autoConfig.scheduleTypeUnset") }}
              </el-tag>
            </div>
            <p class="config-meta-line">
              <span class="config-plugin">{{ pluginName(cfg.pluginId) }}</span>
              <span class="config-meta-sep" aria-hidden="true">·</span>
              <span class="config-last-run">
                {{ $t("autoConfig.lastRunAt") }} {{ formatTs(cfg.scheduleLastRunAt) }}
              </span>
            </p>
            <p
              class="config-summary"
              :class="{ 'config-summary--muted': !cfg.scheduleEnabled }"
            >
              {{ scheduleSummary(cfg) }}
            </p>
            <ScheduleProgressBar :config="cfg" />
            <AutoConfigCardScheduleEditor v-if="cfg.scheduleEnabled" :config="cfg" />
          </div>

          <div class="cg-tasks" @click.stop>
            <div class="config-tasks-head">{{ $t("autoConfig.relatedTasks") }}</div>
            <AutoConfigRelatedTasks
              :config-id="cfg.id"
              @open-task-images="openTaskImages"
              @open-task-log="openTaskLog"
            />
          </div>

          <div class="cg-actions" @click.stop>
            <el-button type="primary" size="small" @click="handleRunNow(cfg.id)">
              {{ $t("autoConfig.runNow") }}
            </el-button>
            <el-dropdown trigger="click" @command="(cmd: string) => handleMoreCommand(cmd, cfg)">
              <el-button size="small">
                {{ $t("autoConfig.moreActions") }}
                <el-icon class="cg-actions-caret"><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="edit">{{ $t("autoConfig.edit") }}</el-dropdown-item>
                  <el-dropdown-item command="copy">{{ $t("autoConfig.copy") }}</el-dropdown-item>
                  <el-dropdown-item command="delete" divided>
                    {{ $t("autoConfig.delete") }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { AlarmClock, ArrowDown } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import { useI18n, resolveConfigText } from "@kabegame/i18n";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import ScheduleProgressBar from "@kabegame/core/components/scheduler/ScheduleProgressBar.vue";
import TaskLogDialog from "@kabegame/core/components/task/TaskLogDialog.vue";
import AutoConfigRelatedTasks from "@/components/scheduler/AutoConfigRelatedTasks.vue";
import AutoConfigCardScheduleEditor from "@/components/scheduler/AutoConfigCardScheduleEditor.vue";
import { HeaderFeatureId } from "@kabegame/core/stores/header";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { useHelpDrawerStore } from "@/stores/helpDrawer";
import { useAutoConfigDialogStore } from "@/stores/autoConfigDialog";
import type { RunConfig } from "@kabegame/core/stores/crawler";

const { t, locale } = useI18n();
const router = useRouter();
const crawlerStore = useCrawlerStore();
const autoConfigDialog = useAutoConfigDialogStore();
const pluginStore = usePluginStore();
const helpDrawer = useHelpDrawerStore();

const onlyEnabled = ref(false);
/** 正在切换 scheduleEnabled 的配置 id，避免重复点击 */
const scheduleTogglingId = ref<string | null>(null);
/** pluginId -> data URL，与 App / 插件浏览器同源接口 */
const pluginIconById = ref<Record<string, string>>({});
const taskLogDialogRef = ref<InstanceType<typeof TaskLogDialog> | null>(null);

const configs = computed(() => crawlerStore.runConfigs);
const filteredConfigs = computed(() =>
  configs.value.filter((item) => (onlyEnabled.value ? item.scheduleEnabled : true)),
);

const toolbarCountText = computed(() => {
  const total = configs.value.length;
  const shown = filteredConfigs.value.length;
  if (onlyEnabled.value) {
    return t("autoConfig.listFiltered", { shown, total });
  }
  return t("autoConfig.listCount", { total });
});

function toPngDataUrl(iconData: number[]): string {
  const bytes = new Uint8Array(iconData);
  const binaryString = Array.from(bytes)
    .map((byte) => String.fromCharCode(byte))
    .join("");
  return `data:image/png;base64,${btoa(binaryString)}`;
}

async function ensurePluginIcon(pluginId: string) {
  if (!pluginId || pluginIconById.value[pluginId]) return;
  try {
    const iconData = await invoke<number[] | null>("get_plugin_icon", { pluginId });
    if (iconData && iconData.length > 0) {
      pluginIconById.value = { ...pluginIconById.value, [pluginId]: toPngDataUrl(iconData) };
    }
  } catch {
    // 无图标或失败时保持空
  }
}

watch(
  () => [...new Set(configs.value.map((c) => c.pluginId).filter(Boolean))],
  (ids) => {
    void Promise.all(ids.map((id) => ensurePluginIcon(id)));
  },
  { immediate: true },
);

const pluginIconUrl = (pluginId: string) => pluginIconById.value[pluginId];

const openTaskImages = (taskId: string) => {
  void router.push({ name: "TaskDetail", params: { id: taskId } });
};

const onConfigCardClick = (cfg: RunConfig, e: MouseEvent) => {
  const t = e.target as HTMLElement | null;
  if (!t) return;
  if (t.closest(".cg-icon, .cg-tasks, .cg-actions, .cg-schedule, .el-switch, .el-button, .el-dropdown")) {
    return;
  }
  autoConfigDialog.openExisting(cfg.id, "view");
};

const openTaskLog = async (taskId: string) => {
  await taskLogDialogRef.value?.openTaskLog(taskId);
};

const resolveText = (value: unknown) => resolveConfigText(value as any, locale.value);

const pluginName = (pluginId: string) => pluginStore.pluginLabel(pluginId);

const formatTs = (ts?: number) => {
  if (!ts) return t("autoConfig.never");
  const ms = ts > 9_999_999_999 ? ts : ts * 1000;
  return new Date(ms).toLocaleString();
};

const formatInterval = (secs?: number) => {
  const n = Number(secs ?? 0);
  if (!Number.isFinite(n) || n <= 0) return t("autoConfig.unset");
  if (n % 86400 === 0) return t("autoConfig.everyDays", { n: n / 86400 });
  if (n % 3600 === 0) return t("autoConfig.everyHours", { n: n / 3600 });
  if (n % 60 === 0) return t("autoConfig.everyMinutes", { n: n / 60 });
  return t("autoConfig.everySeconds", { n });
};

const scheduleModeTitle = (cfg: RunConfig) => {
  switch (cfg.scheduleMode) {
    case "interval":
      return t("autoConfig.modeInterval");
    case "daily":
      return t("autoConfig.modeDaily");
    default:
      return t("autoConfig.unset");
  }
};

const scheduleSummary = (cfg: RunConfig) => {
  if (!cfg.scheduleEnabled) return t("autoConfig.scheduleDisabled");
  switch (cfg.scheduleMode) {
    case "interval":
      return formatInterval(cfg.scheduleIntervalSecs);
    case "daily": {
      const minute = Number(cfg.scheduleDailyMinute ?? 0);
      if (cfg.scheduleDailyHour === -1) {
        return t("autoConfig.dailyHourly", { minute: String(minute).padStart(2, "0") });
      }
      const hour = Number(cfg.scheduleDailyHour ?? 0);
      return t("autoConfig.dailyAt", {
        hour: String(hour).padStart(2, "0"),
        minute: String(minute).padStart(2, "0"),
      });
    }
    default:
      return t("autoConfig.unset");
  }
};

const goCreate = () => {
  autoConfigDialog.openCreate();
};

const handleDelete = async (id: string) => {
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
    if (enabled && !cfg.scheduleMode) {
      const d = new Date();
      await crawlerStore.updateRunConfig({
        ...cfg,
        scheduleEnabled: true,
        scheduleMode: "daily",
        scheduleDailyHour: d.getHours(),
        scheduleDailyMinute: d.getMinutes(),
        scheduleIntervalSecs: undefined,
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

const handleHeaderAction = (payload: { id: string }) => {
  if (payload.id === HeaderFeatureId.Help) {
    helpDrawer.open("gallery");
  }
};
</script>

<style scoped lang="scss">
.auto-configs-container {
  height: 100%;
  padding: 20px;
}

.auto-configs-toolbar {
  margin-top: 16px;
  margin-bottom: 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border-radius: 12px;
  background: var(--anime-bg-card);
  border: 1px solid var(--anime-border);
  box-shadow: 0 1px 8px rgba(255, 107, 157, 0.08);
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.toolbar-count {
  font-size: 13px;
  color: var(--anime-text-muted);
  white-space: nowrap;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-label {
  font-size: 13px;
  color: var(--anime-text-secondary);
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

.auto-configs-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 覆盖全局 .el-card:hover 的 translateY，仅保留阴影反馈 */
.config-card.el-card {
  cursor: pointer;
  border: 1px solid var(--anime-border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: inset 3px 0 0 0 var(--anime-primary), 0 2px 10px rgba(255, 107, 157, 0.06);
  transform: none;
  transition:
    box-shadow 0.2s ease,
    border-color 0.2s ease;

  &:hover {
    border-color: rgba(255, 107, 157, 0.45);
    box-shadow: inset 3px 0 0 0 var(--anime-primary-dark), var(--anime-shadow-hover);
    transform: none;
  }

  :deep(.el-card__body) {
    padding: 16px 18px 16px 16px;
  }
}

/* 默认窄屏：关联任务在配置信息下方占满宽 */
.config-card-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-areas:
    "icon main"
    "tasks tasks"
    "actions actions";
  gap: 12px 16px;
  align-items: start;
}

.cg-icon {
  grid-area: icon;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.schedule-enable-switch {
  flex-shrink: 0;
}

.plugin-icon-frame {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--el-fill-color-light);
  border: 1px solid var(--anime-border);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(124, 58, 237, 0.12);

  &--placeholder {
    background: linear-gradient(145deg, rgba(255, 107, 157, 0.12), rgba(167, 139, 250, 0.15));
  }
}

.plugin-icon-fallback {
  color: var(--anime-text-secondary);
}

.plugin-icon-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.cg-main {
  grid-area: main;
  min-width: 0;
}

.cg-tasks {
  grid-area: tasks;
  min-width: 0;
  width: 100%;
  margin-top: 4px;
  padding: 12px 12px 10px;
  border-radius: 10px;
  background: linear-gradient(
    160deg,
    rgba(255, 107, 157, 0.06) 0%,
    rgba(167, 139, 250, 0.08) 100%
  );
  border: 1px solid rgba(255, 107, 157, 0.15);
}

.config-tasks-head {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--anime-text-secondary);
  margin-bottom: 8px;
  opacity: 0.9;
}

.cg-actions {
  grid-area: actions;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  margin-top: 4px;
}

.cg-actions-caret {
  margin-left: 4px;
  vertical-align: middle;
}

.config-title-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.config-name {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--anime-text-primary);
  letter-spacing: 0.01em;
}

.config-mode-tag {
  flex-shrink: 0;
}

.config-meta-line {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--anime-text-muted);
  line-height: 1.4;
}

.config-meta-sep {
  margin: 0 4px;
  opacity: 0.7;
}

.config-plugin {
  color: var(--anime-text-secondary);
}

.config-last-run {
  color: var(--anime-text-muted);
}

.config-summary {
  margin: 10px 0 0;
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 8px 12px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--anime-primary-dark, var(--anime-primary));
  line-height: 1.45;
  border-radius: 10px;
  background: linear-gradient(
    125deg,
    rgba(255, 107, 157, 0.16) 0%,
    rgba(167, 139, 250, 0.14) 100%
  );
  border: 1px solid rgba(255, 107, 157, 0.28);
  box-shadow: 0 1px 6px rgba(124, 58, 237, 0.1);
}

.config-summary--muted {
  font-weight: 500;
  font-size: 14px;
  letter-spacing: normal;
  color: var(--anime-text-muted);
  background: var(--el-fill-color-light);
  border-color: var(--anime-border);
  box-shadow: none;
}

/* 宽屏：插件图标 + 主信息 + 关联任务三列，任务在右侧 */
@media (min-width: 1024px) {
  .config-card-grid {
    grid-template-columns: auto minmax(0, 1fr) minmax(300px, 440px);
    grid-template-areas:
      "icon main tasks"
      "actions actions actions";
  }

  .cg-tasks {
    margin-top: 0;
  }

  .cg-actions {
    padding-top: 6px;
    margin-top: 2px;
  }
}
</style>
