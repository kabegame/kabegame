<template>
  <div class="flex min-w-0 flex-col gap-4" :class="disabled ? 'pointer-events-none opacity-70' : ''">
    <div class="grid grid-cols-5 gap-1 rounded-xl bg-[var(--el-fill-color-light)] p-1">
      <button
        v-for="item in modes"
        :key="item.value"
        type="button"
        class="rounded-lg border-0 px-1 py-2 text-xs text-[var(--anime-text-secondary)]"
        :class="
          mode === item.value ? 'bg-[var(--el-bg-color)] font-semibold text-[var(--anime-primary)] shadow-sm' : ''
        "
        @click="setMode(item.value)"
      >
        {{ item.label }}
      </button>
    </div>

    <template v-if="draft">
      <div v-if="draft.mode === 'interval'" class="flex flex-col gap-3">
        <div class="flex flex-wrap gap-2">
          <el-button
            v-for="item in intervalPresets"
            :key="item.value"
            size="small"
            round
            @click="setInterval(item.value)"
          >
            {{ item.label }}
          </el-button>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-sm">{{ t("autoConfig.customInterval") }}</span>
          <el-input-number v-model="intervalValue" :min="1" class="!w-28" @change="emitInterval" />
          <el-select v-model="intervalUnit" class="!w-28" @change="emitInterval">
            <el-option value="minutes" :label="t('autoConfig.unitMinutes')" />
            <el-option value="hours" :label="t('autoConfig.unitHours')" />
            <el-option value="days" :label="t('autoConfig.unitDays')" />
          </el-select>
        </div>
      </div>

      <div v-else-if="draft.mode === 'hourly'" class="flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <span class="text-sm">{{ t("autoConfig.hourlyMinute") }}</span>
          <el-input-number v-model="draft.minute" :min="0" :max="59" class="!w-28" @change="commit" />
        </div>
        <div class="flex flex-wrap gap-2">
          <el-button v-for="minute in [0, 15, 30, 45]" :key="minute" size="small" round @click="setHourly(minute)">
            :{{ String(minute).padStart(2, "0") }}
          </el-button>
        </div>
      </div>

      <template v-else>
        <div v-if="draft.mode === 'weekly'" class="flex flex-col gap-3">
          <div class="grid grid-cols-7 gap-1">
            <button
              v-for="day in 7"
              :key="day - 1"
              type="button"
              class="rounded-lg border border-[var(--anime-border)] bg-[var(--el-bg-color)] py-2 text-xs"
              :class="
                draft.weekdays.includes(day - 1)
                  ? '!border-[var(--anime-primary)] !bg-[var(--anime-primary)] !text-white'
                  : ''
              "
              @click="toggleDay(day - 1)"
            >
              {{ t(`autoConfig.weekdayShort${day - 1}`) }}
            </button>
          </div>
          <div class="flex flex-wrap gap-2">
            <el-button size="small" round @click="setDays([0, 1, 2, 3, 4])">{{ t("autoConfig.workdays") }}</el-button>
            <el-button size="small" round @click="setDays([5, 6])">{{ t("autoConfig.weekend") }}</el-button>
            <el-button size="small" round @click="setDays([0, 1, 2, 3, 4, 5, 6])">
              {{ t("autoConfig.everyDay") }}
            </el-button>
          </div>
        </div>
        <!-- 原生 type=time 随浏览器 locale 显示，CEF 下会变成 12 小时制「09:05 AM」；固定 24 小时制 -->
        <el-time-picker
          class="!w-36"
          :model-value="timeValue"
          format="HH:mm"
          value-format="HH:mm"
          :clearable="false"
          :editable="true"
          @update:model-value="(value: string | null) => value && setTime(value)"
        />
        <div class="flex flex-wrap gap-2">
          <el-button v-for="time in commonTimes" :key="time" size="small" round @click="setTime(time)">
            {{ time }}
          </el-button>
        </div>
      </template>
    </template>

    <p v-else class="m-0 text-sm text-[var(--anime-text-muted)]">{{ t("autoConfig.manualHint") }}</p>

    <div v-if="draft" class="rounded-xl bg-[var(--el-fill-color-light)] px-3 py-2 text-sm">
      <div class="font-semibold">{{ specText(draft, t) }}</div>
      <div class="mt-1 text-xs text-[var(--anime-text-muted)]">
        {{ t("autoConfig.nextRuns") }}
        {{
          previewNextRuns(draft)
            .map((time) => formatRunTime(time, t))
            .join(" · ")
        }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import type { ScheduleSpec } from "@/stores/crawler";
import { cloneScheduleSpec, formatRunTime, previewNextRuns, specText } from "@/utils/scheduleText";

const model = defineModel<ScheduleSpec | null | undefined>({ required: true });
withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false });
const { t } = useI18n();
const draft = ref<ScheduleSpec | null>(model.value ? cloneScheduleSpec(model.value) : null);
const mode = computed(() => draft.value?.mode ?? "none");
const intervalValue = ref(1);
const intervalUnit = ref<"minutes" | "hours" | "days">("hours");
const modes = computed(() => [
  { value: "interval", label: t("autoConfig.modeIntervalShort") },
  { value: "hourly", label: t("autoConfig.modeHourly") },
  { value: "daily", label: t("autoConfig.modeDailyShort") },
  { value: "weekly", label: t("autoConfig.modeWeeklyShort") },
  { value: "none", label: t("autoConfig.manual") },
]);
const commonTimes = ["06:00", "08:00", "09:00", "12:00", "18:00", "21:00", "00:00"];
const intervalPresets = computed(() =>
  [15 * 60, 30 * 60, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400].map((value) => ({
    value,
    label: specText({ mode: "interval", intervalSecs: value }, t),
  })),
);
const timeValue = computed(() => {
  const value = draft.value;
  if (!value || (value.mode !== "daily" && value.mode !== "weekly")) return "08:00";
  return `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
});

watch(
  model,
  (value) => {
    draft.value = value ? cloneScheduleSpec(value) : null;
    syncInterval();
  },
  { deep: true },
);

function commit() {
  model.value = draft.value ? cloneScheduleSpec(draft.value) : null;
}
function syncInterval() {
  if (draft.value?.mode !== "interval") return;
  const seconds = draft.value.intervalSecs;
  intervalUnit.value = seconds % 86400 === 0 ? "days" : seconds % 3600 === 0 ? "hours" : "minutes";
  intervalValue.value = seconds / (intervalUnit.value === "days" ? 86400 : intervalUnit.value === "hours" ? 3600 : 60);
}
function setMode(value: string) {
  if (value === "none") draft.value = null;
  else if (value === "interval") draft.value = { mode: "interval", intervalSecs: 3600 };
  else if (value === "hourly") draft.value = { mode: "hourly", minute: 0 };
  else if (value === "daily") draft.value = { mode: "daily", hour: 8, minute: 0 };
  else draft.value = { mode: "weekly", weekdays: [0, 1, 2, 3, 4], hour: 8, minute: 0 };
  syncInterval();
  commit();
}
function setInterval(seconds: number) {
  draft.value = { mode: "interval", intervalSecs: seconds };
  syncInterval();
  commit();
}
function emitInterval() {
  const multiplier = intervalUnit.value === "days" ? 86400 : intervalUnit.value === "hours" ? 3600 : 60;
  draft.value = { mode: "interval", intervalSecs: Math.max(1, intervalValue.value) * multiplier };
  commit();
}
function setHourly(minute: number) {
  draft.value = { mode: "hourly", minute };
  commit();
}
function setTime(value: string) {
  const current = draft.value;
  if (!current || (current.mode !== "daily" && current.mode !== "weekly") || !value) return;
  const [hour, minute] = value.split(":").map(Number);
  draft.value = { ...current, hour, minute };
  commit();
}
function setDays(weekdays: number[]) {
  if (draft.value?.mode !== "weekly") return;
  draft.value = { ...draft.value, weekdays };
  commit();
}
function toggleDay(day: number) {
  if (draft.value?.mode !== "weekly") return;
  const selected = draft.value.weekdays.includes(day);
  if (selected && draft.value.weekdays.length === 1) return;
  setDays(selected ? draft.value.weekdays.filter((value) => value !== day) : [...draft.value.weekdays, day].sort());
}
</script>
