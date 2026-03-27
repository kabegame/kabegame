<template>
  <div class="cg-schedule" @click.stop>
    <div class="schedule-editor-head">
      <span class="schedule-editor-label">{{ $t("autoConfig.schedule") }}</span>
      <span v-if="saving" class="schedule-editor-saving">{{ $t("common.loading") }}</span>
    </div>
    <div class="schedule-editor-rows">
      <el-radio-group v-model="mode" size="small" class="schedule-mode-group" :disabled="saving"
        @change="onModeChanged">
        <el-radio-button value="interval">{{ $t("autoConfig.modeInterval") }}</el-radio-button>
        <el-radio-button value="daily">{{ $t("autoConfig.modeDaily") }}</el-radio-button>
      </el-radio-group>

      <div v-if="mode === 'interval'" class="schedule-editor-row">
        <el-input-number v-model="intervalValue" :min="1" size="small" :disabled="saving" controls-position="right"
          @change="onIntervalFieldsChange" />
        <el-select v-model="intervalUnit" size="small" class="schedule-unit-select" :disabled="saving"
          @change="onIntervalFieldsChange">
          <el-option value="minutes" :label="$t('autoConfig.unitMinutes')" />
          <el-option value="hours" :label="$t('autoConfig.unitHours')" />
          <el-option value="days" :label="$t('autoConfig.unitDays')" />
        </el-select>
      </div>

      <div v-else class="schedule-editor-row">
        <el-select v-model="dailyHour" size="small" class="schedule-daily-select" :disabled="saving" @change="persist">
          <el-option :value="-1" :label="$t('autoConfig.everyHour')" />
          <el-option v-for="h in 24" :key="`h-${h - 1}`" :value="h - 1"
            :label="`${String(h - 1).padStart(2, '0')}:xx`" />
        </el-select>
        <el-select v-model="dailyMinute" size="small" class="schedule-daily-select" :disabled="saving"
          @change="persist">
          <el-option v-for="m in 60" :key="`m-${m - 1}`" :value="m - 1" :label="String(m - 1).padStart(2, '0')" />
        </el-select>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useI18n } from "@kabegame/i18n";
import { useCrawlerStore } from "@/stores/crawler";
import type { RunConfig } from "@kabegame/core/stores/crawler";

const props = defineProps<{ config: RunConfig }>();

const { t } = useI18n();
const crawlerStore = useCrawlerStore();

const saving = ref(false);
const syncing = ref(false);
const mode = ref<"interval" | "daily">("daily");
const intervalValue = ref(1);
const intervalUnit = ref<"minutes" | "hours" | "days">("hours");
const dailyHour = ref(0);
const dailyMinute = ref(0);

const secondsByUnit = (unit: "minutes" | "hours" | "days") => {
  if (unit === "days") return 86400;
  if (unit === "hours") return 3600;
  return 60;
};

/** 与后端 `compute_next_planned_at` 对齐：下一次绝对触发时刻（Unix 秒） */
function computeNextPlannedAtUnix(params: {
  mode: "interval" | "daily";
  intervalSecs: number;
  dailyHour: number;
  dailyMinute: number;
}): number {
  const nowSec = Math.floor(Date.now() / 1000);
  if (params.mode === "interval") {
    const iv = Math.max(60, Number(params.intervalSecs) || 3600);
    return nowSec + iv;
  }
  const minute = Math.min(59, Math.max(0, params.dailyMinute));
  const d = new Date(nowSec * 1000);
  if (params.dailyHour === -1) {
    const slot = new Date(d.getTime());
    slot.setSeconds(0, 0);
    slot.setMinutes(minute);
    if (Math.floor(slot.getTime() / 1000) <= nowSec) {
      slot.setHours(slot.getHours() + 1);
      slot.setMinutes(minute);
      slot.setSeconds(0, 0);
    }
    return Math.floor(slot.getTime() / 1000);
  }
  const hour = Math.min(23, Math.max(0, params.dailyHour));
  const slot = new Date(d.getTime());
  slot.setHours(hour, minute, 0, 0);
  if (Math.floor(slot.getTime() / 1000) <= nowSec) {
    slot.setDate(slot.getDate() + 1);
    slot.setHours(hour, minute, 0, 0);
  }
  return Math.floor(slot.getTime() / 1000);
}

function applyNowDaily() {
  const d = new Date();
  dailyHour.value = d.getHours();
  dailyMinute.value = d.getMinutes();
}

/** 清空「间隔」模式专用本地字段（切换为 daily 或同步 daily 配置时用） */
function clearIntervalRefs() {
  intervalValue.value = 1;
  intervalUnit.value = "hours";
}

/** 清空「每日」模式专用本地字段（切换为 interval 或同步 interval 配置时用） */
function clearDailyRefs() {
  dailyHour.value = 0;
  dailyMinute.value = 0;
}

function syncFromConfig(cfg: RunConfig) {
  syncing.value = true;
  if (cfg.scheduleMode === "interval") {
    mode.value = "interval";
    const secs = Math.max(60, Number(cfg.scheduleIntervalSecs ?? 3600));
    if (secs % 86400 === 0) {
      intervalUnit.value = "days";
      intervalValue.value = Math.max(1, Math.round(secs / 86400));
    } else if (secs % 3600 === 0) {
      intervalUnit.value = "hours";
      intervalValue.value = Math.max(1, Math.round(secs / 3600));
    } else {
      intervalUnit.value = "minutes";
      intervalValue.value = Math.max(1, Math.round(secs / 60));
    }
    clearDailyRefs();
  } else if (cfg.scheduleMode === "daily") {
    mode.value = "daily";
    dailyHour.value = Number(cfg.scheduleDailyHour ?? -1);
    dailyMinute.value = Number(cfg.scheduleDailyMinute ?? 0);
    clearIntervalRefs();
  } else {
    mode.value = "daily";
    applyNowDaily();
    clearIntervalRefs();
  }
  void nextTick(() => {
    syncing.value = false;
  });
}

watch(
  () =>
    [
      props.config.id,
      props.config.scheduleEnabled,
      props.config.scheduleMode,
      props.config.scheduleIntervalSecs,
      props.config.scheduleDailyHour,
      props.config.scheduleDailyMinute,
    ] as const,
  () => syncFromConfig(props.config),
  { immediate: true },
);

onMounted(() => {
  if (props.config.scheduleEnabled && !props.config.scheduleMode) {
    void nextTick(() => persist());
  }
});

function onModeChanged() {
  if (syncing.value) return;
  if (mode.value === "interval") {
    intervalValue.value = 1;
    intervalUnit.value = "hours";
    clearDailyRefs();
  } else {
    applyNowDaily();
    clearIntervalRefs();
  }
  void persist();
}

function onIntervalFieldsChange() {
  if (syncing.value) return;
  void persist();
}

async function persist() {
  if (syncing.value) return;
  const base =
    crawlerStore.runConfigs.find((c) => c.id === props.config.id) ?? props.config;
  if (saving.value) return;
  saving.value = true;
  try {
    let next: RunConfig;
    if (mode.value === "interval") {
      const iv = Math.max(1, Number(intervalValue.value) || 1);
      const intervalSecs = iv * secondsByUnit(intervalUnit.value);
      const schedulePlannedAt = computeNextPlannedAtUnix({
        mode: "interval",
        intervalSecs,
        dailyHour: 0,
        dailyMinute: 0,
      });
      next = {
        ...base,
        schedulePlannedAt,
        scheduleEnabled: true,
        scheduleMode: "interval",
        scheduleIntervalSecs: intervalSecs,
        scheduleDailyHour: undefined,
        scheduleDailyMinute: undefined,
      };
    } else {
      const schedulePlannedAt = computeNextPlannedAtUnix({
        mode: "daily",
        intervalSecs: 0,
        dailyHour: dailyHour.value,
        dailyMinute: dailyMinute.value,
      });
      next = {
        ...base,
        schedulePlannedAt,
        scheduleEnabled: true,
        scheduleMode: "daily",
        scheduleIntervalSecs: undefined,
        scheduleDailyHour: dailyHour.value,
        scheduleDailyMinute: dailyMinute.value,
      };
    }
    await crawlerStore.updateRunConfig(next);
  } catch {
    ElMessage.error(t("common.operationFailed"));
    syncFromConfig(base);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped lang="scss">
.cg-schedule {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.45);
  border: 1px solid rgba(255, 107, 157, 0.2);
}

.schedule-editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.schedule-editor-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--anime-text-secondary);
}

.schedule-editor-saving {
  font-size: 11px;
  color: var(--anime-text-muted);
}

.schedule-editor-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.schedule-mode-group {
  width: 100%;
  display: flex;
  flex-wrap: wrap;
}

.schedule-mode-group :deep(.el-radio-button) {
  flex: 1;
}

.schedule-mode-group :deep(.el-radio-button__inner) {
  width: 100%;
  padding-left: 8px;
  padding-right: 8px;
}

.schedule-editor-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.schedule-editor-row :deep(.el-input-number) {
  flex: 1;
  min-width: 100px;
}

.schedule-unit-select,
.schedule-daily-select {
  flex: 1;
  min-width: 0;
}
</style>
