<template>
  <el-dialog
    v-model="visible"
    :title="$t('autoConfig.missedRuns.title')"
    width="560px"
    :close-on-click-modal="false"
  >
    <div class="missed-runs-desc">
      {{ $t("autoConfig.missedRuns.desc") }}
    </div>
    <div class="missed-runs-list">
      <div v-for="item in items" :key="item.configId" class="missed-runs-item">
        <div class="name">{{ item.configName || item.configId }}</div>
        <div class="meta">
          <span>{{ modeText(item.scheduleMode) }}</span>
          <span>{{ $t("autoConfig.missedRuns.missedCount", { n: item.missedCount }) }}</span>
          <span>{{ $t("autoConfig.missedRuns.lastDueAt", { time: formatTime(item.lastDueAt) }) }}</span>
        </div>
      </div>
    </div>
    <template #footer>
      <el-button @click="$emit('dismiss')">{{ $t("autoConfig.missedRuns.dismiss") }}</el-button>
      <el-button type="primary" @click="$emit('run-now')">{{ $t("autoConfig.missedRuns.runNow") }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import type { MissedRunItem } from "@kabegame/core/stores/crawler";

const props = defineProps<{
  modelValue: boolean;
  items: MissedRunItem[];
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  "run-now": [];
  dismiss: [];
}>();

const { t } = useI18n();

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value),
});

useModalBack(visible);

const modeText = (mode: MissedRunItem["scheduleMode"]) => {
  if (mode === "interval") return t("autoConfig.modeInterval");
  if (mode === "daily") return t("autoConfig.modeDaily");
  if (mode === "weekly") return t("autoConfig.modeWeekly");
  return t("autoConfig.unset");
};

const formatTime = (ts: number) => {
  const ms = ts > 9_999_999_999 ? ts : ts * 1000;
  return new Date(ms).toLocaleString();
};
</script>

<style scoped lang="scss">
.missed-runs-desc {
  margin-bottom: 12px;
  color: var(--anime-text-secondary);
  font-size: 14px;
}

.missed-runs-list {
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.missed-runs-item {
  border: 1px solid var(--anime-border);
  border-radius: 8px;
  padding: 10px;
}

.name {
  font-size: 14px;
  font-weight: 600;
  color: var(--anime-text-primary);
}

.meta {
  margin-top: 6px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--anime-text-secondary);
  font-size: 12px;
}
</style>
