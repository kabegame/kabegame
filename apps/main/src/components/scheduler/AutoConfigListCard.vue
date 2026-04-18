<template>
  <el-card class="config-card"
    :class="variant === 'android' ? 'config-card--layout-android' : 'config-card--layout-desktop'" role="button"
    tabindex="0" @click="onCardClick($event)" @keydown.enter.prevent="emit('open-view', config.id)"
    @keydown.space.prevent="emit('open-view', config.id)">
    <div class="config-card-grid"
      :class="variant === 'android' ? 'config-card-grid--android' : 'config-card-grid--desktop'">
      <div class="cg-icon" @click.stop>
        <div class="plugin-icon-frame" :class="{ 'plugin-icon-frame--placeholder': !pluginIconUrl(config.pluginId) }">
          <img v-if="pluginIconUrl(config.pluginId)" class="plugin-icon-img" :src="pluginIconUrl(config.pluginId)"
            alt="" />
          <el-icon v-else :size="26" class="plugin-icon-fallback">
            <AlarmClock />
          </el-icon>
        </div>
        <el-switch class="schedule-enable-switch" size="small" :model-value="config.scheduleEnabled"
          :disabled="scheduleTogglingId === config.id"
          @update:model-value="(v: string | number | boolean) => emit('schedule-enabled', config, Boolean(v))" />
      </div>

      <div class="cg-main cg-main--scroll">
        <div class="config-title-line">
          <h3 class="config-name">{{ resolveText(config.name) }}</h3>
          <el-tag v-if="config.scheduleSpec?.mode" class="config-mode-tag" type="primary" size="small" effect="plain">
            {{ scheduleModeTitle(config) }}
          </el-tag>
        </div>
        <p class="config-meta-line">
          <span class="config-plugin">{{ pluginName(config.pluginId) }}</span>
          <span class="config-meta-sep" aria-hidden="true">·</span>
          <span class="config-last-run">
            {{ t("autoConfig.lastRunAt") }} {{ formatTs(config.scheduleLastRunAt) }}
          </span>
        </p>
        <p class="config-summary" :class="{ 'config-summary--muted': !config.scheduleEnabled }">
          {{ scheduleSummary(config) }}
        </p>
        <AutoConfigCardScheduleEditor v-if="
          config.scheduleEnabled ||
          config.scheduleSpec?.mode === 'interval' ||
          config.scheduleSpec?.mode === 'daily' ||
          config.scheduleSpec?.mode === 'weekly'
        " :config="config" />
        <ScheduleProgressBar :config="config" />
      </div>

      <div class="cg-tasks" @click.stop>
        <div class="config-tasks-head">{{ t("autoConfig.relatedTasks") }}</div>
        <AutoConfigRelatedTasks :config-id="config.id" :variant="variant"
          @open-task-images="emit('open-task-images', $event)" @open-task-log="emit('open-task-log', $event)" />
      </div>

      <div class="cg-actions" @click.stop>
        <el-button type="primary" size="small" @click="emit('run-now', config.id)">
          {{ t("autoConfig.runNow") }}
        </el-button>
        <el-dropdown trigger="click" @command="(cmd: string) => emit('more-command', cmd, config)">
          <el-button size="small">
            {{ t("autoConfig.moreActions") }}
            <el-icon class="cg-actions-caret">
              <ArrowDown />
            </el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="edit">{{ t("autoConfig.edit") }}</el-dropdown-item>
              <el-dropdown-item command="copy">{{ t("autoConfig.copy") }}</el-dropdown-item>
              <el-dropdown-item command="delete" divided>
                {{ t("autoConfig.delete") }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { AlarmClock, ArrowDown } from "@element-plus/icons-vue";
import { useI18n, resolveConfigText } from "@kabegame/i18n";
import ScheduleProgressBar from "@kabegame/core/components/scheduler/ScheduleProgressBar.vue";
import AutoConfigCardScheduleEditor from "@/components/scheduler/AutoConfigCardScheduleEditor.vue";
import AutoConfigRelatedTasks from "@/components/scheduler/AutoConfigRelatedTasks.vue";
import { usePluginStore } from "@/stores/plugins";
import type { RunConfig } from "@kabegame/core/stores/crawler";

const props = defineProps<{
  config: RunConfig;
  variant: "android" | "desktop";
  scheduleTogglingId: string | null;
}>();

const emit = defineEmits<{
  (e: "card-click", cfg: RunConfig, ev: MouseEvent): void;
  (e: "open-view", id: string): void;
  (e: "schedule-enabled", cfg: RunConfig, enabled: boolean): void;
  (e: "run-now", id: string): void;
  (e: "more-command", cmd: string, cfg: RunConfig): void;
  (e: "open-task-images", taskId: string): void;
  (e: "open-task-log", taskId: string): void;
}>();

const { t, locale } = useI18n();
const pluginStore = usePluginStore();

const pluginIconUrl = (pluginId: string) => pluginStore.pluginIconDataUrl(pluginId);
const pluginName = (pluginId: string) => pluginStore.pluginLabel(pluginId);
const resolveText = (value: unknown) => resolveConfigText(value as any, locale.value);

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
  switch (cfg.scheduleSpec?.mode) {
    case "interval":
      return t("autoConfig.modeInterval");
    case "daily":
      return t("autoConfig.modeDaily");
    case "weekly":
      return t("autoConfig.modeWeekly");
    default:
      return t("autoConfig.unset");
  }
};

const scheduleBodySummary = (cfg: RunConfig) => {
  const s = cfg.scheduleSpec;
  switch (s?.mode) {
    case "interval":
      return formatInterval(s.intervalSecs);
    case "daily": {
      const minute = Number(s.minute ?? 0);
      if (s.hour === -1) {
        return t("autoConfig.dailyHourly", { minute: String(minute).padStart(2, "0") });
      }
      const hour = Number(s.hour ?? 0);
      return t("autoConfig.dailyAt", {
        hour: String(hour).padStart(2, "0"),
        minute: String(minute).padStart(2, "0"),
      });
    }
    case "weekly": {
      const wd = Math.min(6, Math.max(0, Number(s.weekday ?? 0)));
      return t("autoConfig.weeklyAt", {
        weekday: t(`autoConfig.weekday${wd}`),
        hour: String(Number(s.hour ?? 0)).padStart(2, "0"),
        minute: String(Number(s.minute ?? 0)).padStart(2, "0"),
      });
    }
    default:
      return t("autoConfig.unset");
  }
};

const scheduleSummary = (cfg: RunConfig) => {
  if (!cfg.scheduleEnabled) {
    if (
      cfg.scheduleSpec?.mode === "interval" ||
      cfg.scheduleSpec?.mode === "daily" ||
      cfg.scheduleSpec?.mode === "weekly"
    ) {
      return scheduleBodySummary(cfg);
    }
    return t("autoConfig.scheduleDisabled");
  }
  return scheduleBodySummary(cfg);
};

function onCardClick(e: MouseEvent) {
  const el = e.target as HTMLElement | null;
  if (!el) return;
  if (
    el.closest(
      ".cg-icon, .cg-tasks, .cg-actions, .cg-schedule, .el-switch, .el-button, .el-dropdown",
    )
  ) {
    return;
  }
  emit("card-click", props.config, e);
}
</script>

<style scoped lang="scss">
.config-card.el-card {
  cursor: pointer;
  border: 1px solid var(--anime-border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.05);
  transform: none;
  transition:
    box-shadow 0.2s ease,
    border-color 0.2s ease;
  display: flex;
  flex-direction: column;
  min-height: 0;

  &:hover {
    border-color: var(--anime-border);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
    transform: none;
  }

  :deep(.el-card__body) {
    flex: 1;
    min-height: 0;
    padding: 12px;
    box-sizing: border-box;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
}

.config-card-grid {
  display: grid;
  gap: 10px 14px;
  align-items: start;
  min-height: 0;
  flex: 1;
}

/* 安卓：纵向（与原先窄屏一致） */
.config-card-grid--android {
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto auto;
  grid-template-areas:
    "icon main"
    "tasks tasks"
    "actions actions";
}

/* 桌面：横向三列；首行占满剩余高度，主栏可滚动 */
.config-card-grid--desktop {
  grid-template-columns: auto 1fr 1fr;
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas:
    "icon main tasks"
    "actions actions actions";
  align-items: stretch;
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
  min-height: 0;
}

.cg-main--scroll {
  overflow-x: hidden;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.cg-tasks {
  grid-area: tasks;
  min-width: 0;
  width: 100%;
  margin-top: 0;
  padding: 10px 10px 8px;
  border-radius: 10px;
  background: linear-gradient(160deg,
      rgba(255, 107, 157, 0.06) 0%,
      rgba(167, 139, 250, 0.08) 100%);
  border: 1px solid rgba(255, 107, 157, 0.15);
}

.config-card-grid--desktop .cg-tasks {
  margin-top: 0;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.config-card-grid--android .cg-tasks {
  flex-shrink: 0;
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
  padding-top: 4px;
  margin-top: 0;
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
  background: linear-gradient(125deg,
      rgba(255, 107, 157, 0.16) 0%,
      rgba(167, 139, 250, 0.14) 100%);
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
</style>
