<template>
  <div class="flex min-w-0 flex-col gap-4" :class="disabled ? 'pointer-events-none opacity-70' : ''">
    <SegmentedControl :model-value="mode" :options="modes" class="w-full" @update:model-value="setMode" />

    <template v-if="draft">
      <div v-if="draft.mode === 'interval'" class="flex flex-col gap-3">
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="item in intervalPresets"
            :key="item.value"
            type="button"
            :class="[CHIP, draft.intervalSecs === item.value ? CHIP_ON : CHIP_OFF]"
            @click="setInterval(item.value)"
          >
            {{ item.label }}
          </button>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[13px] text-kb-fg-muted">{{ t("autoConfig.customInterval") }}</span>
          <NumberField
            :model-value="intervalValue"
            :min="1"
            class="w-28"
            @update:model-value="(value) => onIntervalValue(value)"
          />
          <Select
            :model-value="intervalUnit"
            :options="unitOptions"
            class="w-28"
            @update:model-value="(value) => onIntervalUnit(value)"
          />
        </div>
      </div>

      <div v-else-if="draft.mode === 'hourly'" class="flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <span class="text-[13px] text-kb-fg-muted">{{ t("autoConfig.hourlyMinute") }}</span>
          <NumberField
            :model-value="draft.minute"
            :min="0"
            :max="59"
            class="w-28"
            @update:model-value="(value) => value != null && setHourly(value)"
          />
        </div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="minute in [0, 15, 30, 45]"
            :key="minute"
            type="button"
            :class="[CHIP, draft.minute === minute ? CHIP_ON : CHIP_OFF]"
            @click="setHourly(minute)"
          >
            :{{ String(minute).padStart(2, "0") }}
          </button>
        </div>
      </div>

      <template v-else>
        <div v-if="draft.mode === 'weekly'" class="flex flex-col gap-3">
          <div class="grid grid-cols-7 gap-1">
            <button
              v-for="day in 7"
              :key="day - 1"
              type="button"
              :aria-pressed="draft.weekdays.includes(day - 1)"
              class="h-8 cursor-pointer rounded-kb-md border border-solid text-[12.5px] [font-family:inherit] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-kb-ring"
              :class="
                draft.weekdays.includes(day - 1)
                  ? 'border-kb-primary bg-kb-primary font-500 text-kb-primary-fg'
                  : 'border-kb-line-strong bg-kb-surface-raised text-kb-fg-regular hover:border-kb-fg-subtle'
              "
              @click="toggleDay(day - 1)"
            >
              {{ t(`autoConfig.weekdayShort${day - 1}`) }}
            </button>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button type="button" :class="[CHIP, CHIP_OFF]" @click="setDays([0, 1, 2, 3, 4])">
              {{ t("autoConfig.workdays") }}
            </button>
            <button type="button" :class="[CHIP, CHIP_OFF]" @click="setDays([5, 6])">
              {{ t("autoConfig.weekend") }}
            </button>
            <button type="button" :class="[CHIP, CHIP_OFF]" @click="setDays([0, 1, 2, 3, 4, 5, 6])">
              {{ t("autoConfig.everyDay") }}
            </button>
          </div>
        </div>
        <TimeField :model-value="timeValue" @update:model-value="setTime" />
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="time in commonTimes"
            :key="time"
            type="button"
            :class="[CHIP, 'tabular-nums', timeValue === time ? CHIP_ON : CHIP_OFF]"
            @click="setTime(time)"
          >
            {{ time }}
          </button>
        </div>
      </template>
    </template>

    <p v-else class="m-0 text-[13px] text-kb-fg-muted">{{ t("autoConfig.manualHint") }}</p>

    <div v-if="draft" class="rounded-kb-md bg-kb-fill-light px-3 py-2 text-[13px]">
      <div class="font-600 text-kb-fg">{{ specText(draft, t) }}</div>
      <div class="mt-1 text-[12px] tabular-nums text-kb-fg-muted">
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
import { NumberField, SegmentedControl, Select, TimeField } from "@/components/ui";
import { cloneScheduleSpec, formatRunTime, previewNextRuns, specText } from "@/utils/scheduleText";

const model = defineModel<ScheduleSpec | null | undefined>({ required: true });
withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false });
const { t } = useI18n();
const draft = ref<ScheduleSpec | null>(model.value ? cloneScheduleSpec(model.value) : null);
const mode = computed(() => draft.value?.mode ?? "none");
const intervalValue = ref(1);
const intervalUnit = ref<"minutes" | "hours" | "days">("hours");
const modes = computed<{ value: string; label: string }[]>(() => [
  { value: "interval", label: t("autoConfig.modeIntervalShort") },
  { value: "hourly", label: t("autoConfig.modeHourly") },
  { value: "daily", label: t("autoConfig.modeDailyShort") },
  { value: "weekly", label: t("autoConfig.modeWeeklyShort") },
  { value: "none", label: t("autoConfig.manual") },
]);
// 快捷取值的小胶囊：当前值就是它时显示为选中
const CHIP =
  "inline-flex h-7 cursor-pointer items-center rounded-full border border-solid px-3 text-[12.5px] [font-family:inherit] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-kb-ring";
const CHIP_OFF =
  "border-kb-line-strong bg-kb-surface-raised text-kb-fg-regular hover:border-kb-fg-subtle hover:text-kb-fg";
const CHIP_ON = "border-kb-fg bg-kb-fill text-kb-fg font-500";
const unitOptions = computed(() => [
  { value: "minutes" as const, label: t("autoConfig.unitMinutes") },
  { value: "hours" as const, label: t("autoConfig.unitHours") },
  { value: "days" as const, label: t("autoConfig.unitDays") },
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
function setMode(value: string | undefined) {
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
function onIntervalValue(value: number | undefined) {
  if (value == null) return;
  intervalValue.value = value;
  emitInterval();
}
function onIntervalUnit(value: "minutes" | "hours" | "days" | undefined) {
  if (!value) return;
  intervalUnit.value = value;
  emitInterval();
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
