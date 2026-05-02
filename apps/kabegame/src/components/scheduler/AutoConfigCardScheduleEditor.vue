<template>
  <div class="cg-schedule" :class="{ 'cg-schedule--readonly': scheduleReadonly }" @click.stop>
    <div class="schedule-editor-head">
      <span class="schedule-editor-label">{{ $t("autoConfig.schedule") }}</span>
      <span v-if="saving" class="schedule-editor-saving">{{ $t("common.loading") }}</span>
    </div>
    <div class="schedule-editor-rows">
      <el-radio-group
        v-model="mode"
        size="small"
        class="schedule-mode-group"
        :disabled="fieldsDisabled"
        @change="onModeChanged"
      >
        <el-radio-button value="interval">{{ $t("autoConfig.modeInterval") }}</el-radio-button>
        <el-radio-button value="daily">{{ $t("autoConfig.modeDaily") }}</el-radio-button>
        <el-radio-button value="weekly">{{ $t("autoConfig.modeWeekly") }}</el-radio-button>
      </el-radio-group>

      <div v-if="mode === 'interval'" class="schedule-editor-row">
        <el-input-number
          v-model="intervalValue"
          :min="1"
          size="small"
          :disabled="fieldsDisabled"
          controls-position="right"
          @change="onIntervalFieldsChange"
        />
        <el-select
          v-model="intervalUnit"
          size="small"
          class="schedule-unit-select"
          :disabled="fieldsDisabled"
          @change="onIntervalFieldsChange"
        >
          <el-option value="minutes" :label="$t('autoConfig.unitMinutes')" />
          <el-option value="hours" :label="$t('autoConfig.unitHours')" />
          <el-option value="days" :label="$t('autoConfig.unitDays')" />
        </el-select>
      </div>

      <div v-else-if="mode === 'daily'" class="schedule-editor-row">
        <el-select
          v-model="dailyHour"
          size="small"
          class="schedule-daily-select"
          :disabled="fieldsDisabled"
          @change="persist"
        >
          <el-option :value="-1" :label="$t('autoConfig.everyHour')" />
          <el-option v-for="h in 24" :key="`h-${h - 1}`" :value="h - 1"
            :label="`${String(h - 1).padStart(2, '0')}:xx`" />
        </el-select>
        <el-select
          v-model="dailyMinute"
          size="small"
          class="schedule-daily-select"
          :disabled="fieldsDisabled"
          @change="persist"
        >
          <el-option v-for="m in 60" :key="`m-${m - 1}`" :value="m - 1" :label="String(m - 1).padStart(2, '0')" />
        </el-select>
      </div>

      <div v-else class="schedule-editor-row schedule-editor-row--weekly">
        <el-select
          v-model="weeklyWeekday"
          size="small"
          class="schedule-daily-select"
          :disabled="fieldsDisabled"
          @change="persist"
        >
          <el-option v-for="wd in 7" :key="`wd-${wd - 1}`" :value="wd - 1" :label="$t(`autoConfig.weekday${wd - 1}`)" />
        </el-select>
        <el-select
          v-model="dailyHour"
          size="small"
          class="schedule-daily-select"
          :disabled="fieldsDisabled"
          @change="persist"
        >
          <el-option v-for="h in 24" :key="`wh-${h - 1}`" :value="h - 1"
            :label="`${String(h - 1).padStart(2, '0')}:xx`" />
        </el-select>
        <el-select
          v-model="dailyMinute"
          size="small"
          class="schedule-daily-select"
          :disabled="fieldsDisabled"
          @change="persist"
        >
          <el-option v-for="m in 60" :key="`wm-${m - 1}`" :value="m - 1" :label="String(m - 1).padStart(2, '0')" />
        </el-select>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useI18n } from "@kabegame/i18n";
import { useCrawlerStore } from "@/stores/crawler";
import type { RunConfig, ScheduleSpec } from "@kabegame/core/stores/crawler";

const props = defineProps<{ config: RunConfig }>();

const { t } = useI18n();
const crawlerStore = useCrawlerStore();

const saving = ref(false);
const syncing = ref(false);

const scheduleReadonly = computed(() => !props.config.scheduleEnabled);
const fieldsDisabled = computed(() => saving.value || scheduleReadonly.value);
const mode = ref<"interval" | "daily" | "weekly">("daily");
const intervalValue = ref(1);
const intervalUnit = ref<"minutes" | "hours" | "days">("hours");
const dailyHour = ref(0);
const dailyMinute = ref(0);
/** 0=周一 … 6=周日，与后端一致 */
const weeklyWeekday = ref(0);

const secondsByUnit = (unit: "minutes" | "hours" | "days") => {
  if (unit === "days") return 86400;
  if (unit === "hours") return 3600;
  return 60;
};

function monday0FromDate(d: Date): number {
  const w = d.getDay();
  return w === 0 ? 6 : w - 1;
}

function applyNowDaily() {
  const d = new Date();
  dailyHour.value = d.getHours();
  dailyMinute.value = d.getMinutes();
}

function applyNowWeekly() {
  const d = new Date();
  weeklyWeekday.value = monday0FromDate(d);
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

function clearWeeklyRefs() {
  weeklyWeekday.value = 0;
}

function syncFromConfig(cfg: RunConfig) {
  syncing.value = true;
  const spec = cfg.scheduleSpec;
  if (spec?.mode === "interval") {
    mode.value = "interval";
    const secs = Math.max(60, Number(spec.intervalSecs ?? 3600));
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
    clearWeeklyRefs();
  } else if (spec?.mode === "daily") {
    mode.value = "daily";
    dailyHour.value = Number(spec.hour ?? -1);
    dailyMinute.value = Number(spec.minute ?? 0);
    clearIntervalRefs();
    clearWeeklyRefs();
  } else if (spec?.mode === "weekly") {
    mode.value = "weekly";
    weeklyWeekday.value = Math.min(6, Math.max(0, Number(spec.weekday ?? 0)));
    dailyHour.value = Math.min(23, Math.max(0, Number(spec.hour ?? 0)));
    dailyMinute.value = Math.min(59, Math.max(0, Number(spec.minute ?? 0)));
    clearIntervalRefs();
  } else {
    mode.value = "daily";
    applyNowDaily();
    clearIntervalRefs();
    clearWeeklyRefs();
  }
  void nextTick(() => {
    syncing.value = false;
  });
}

watch(
  () => props.config,
  () => syncFromConfig(props.config),
  { immediate: true, deep: true },
);

onMounted(() => {
  if (props.config.scheduleEnabled && !props.config.scheduleSpec) {
    void nextTick(() => persist());
  }
});

function onModeChanged() {
  if (syncing.value || !props.config.scheduleEnabled) return;
  if (mode.value === "interval") {
    intervalValue.value = 1;
    intervalUnit.value = "hours";
    clearDailyRefs();
    clearWeeklyRefs();
  } else if (mode.value === "daily") {
    applyNowDaily();
    clearIntervalRefs();
    clearWeeklyRefs();
  } else {
    applyNowWeekly();
    clearIntervalRefs();
  }
  void persist();
}

function onIntervalFieldsChange() {
  if (syncing.value || !props.config.scheduleEnabled) return;
  void persist();
}

async function persist() {
  if (syncing.value || !props.config.scheduleEnabled) return;
  const base =
    crawlerStore.runConfigs.find((c) => c.id === props.config.id) ?? props.config;
  if (saving.value) return;
  saving.value = true;
  try {
    let next: RunConfig;
    if (mode.value === "interval") {
      const iv = Math.max(1, Number(intervalValue.value) || 1);
      const intervalSecs = iv * secondsByUnit(intervalUnit.value);
      const scheduleSpec: ScheduleSpec = { mode: "interval", intervalSecs };
      next = {
        ...base,
        schedulePlannedAt: undefined,
        scheduleEnabled: true,
        scheduleSpec,
      };
    } else if (mode.value === "weekly") {
      const wd = Math.min(6, Math.max(0, weeklyWeekday.value));
      const h = Math.min(23, Math.max(0, dailyHour.value));
      const m = Math.min(59, Math.max(0, dailyMinute.value));
      const scheduleSpec: ScheduleSpec = {
        mode: "weekly",
        weekday: wd,
        hour: h,
        minute: m,
      };
      next = {
        ...base,
        schedulePlannedAt: undefined,
        scheduleEnabled: true,
        scheduleSpec,
      };
    } else {
      const scheduleSpec: ScheduleSpec = {
        mode: "daily",
        hour: dailyHour.value,
        minute: dailyMinute.value,
      };
      next = {
        ...base,
        schedulePlannedAt: undefined,
        scheduleEnabled: true,
        scheduleSpec,
      };
    }
    await crawlerStore.updateRunConfig(next);
  } catch(e) {
    ElMessage.error(t("common.operationFailed"));
    console.error(e);
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

  &--readonly {
    opacity: 0.72;
    background: var(--el-fill-color-light, rgba(0, 0, 0, 0.04));
    border-color: var(--anime-border);
    pointer-events: none;
  }
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

.schedule-editor-row--weekly {
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
