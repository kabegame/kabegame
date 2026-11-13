<template>
  <Dialog
    :open="open"
    :title="$t('autoConfig.missedRuns.title')"
    :description="systemSleep ? $t('autoConfig.missedRuns.sleepDesc') : $t('autoConfig.missedRuns.desc')"
    :width="560"
    @update:open="onUpdateOpen"
    :close-on-overlay="false"
  >
    <div class="flex max-h-80 flex-col gap-2 overflow-y-auto">
      <div
        v-for="item in items"
        :key="item.configId"
        class="rounded-kb-md border border-solid border-kb-line bg-kb-surface-raised px-3 py-2.5"
      >
        <div class="truncate text-[13.5px] font-600 text-kb-fg">{{ item.configName || item.configId }}</div>
        <div class="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[12px] tabular-nums text-kb-fg-muted">
          <span>{{ modeText(item.scheduleMode) }}</span>
          <span>{{ $t("autoConfig.missedRuns.missedCount", { n: item.missedCount }) }}</span>
          <span>{{ $t("autoConfig.missedRuns.lastDueAt", { time: formatTime(item.lastDueAt) }) }}</span>
        </div>
      </div>
    </div>
    <template #footer>
      <Button variant="outline" @click="$emit('dismiss')">{{ $t("autoConfig.missedRuns.dismiss") }}</Button>
      <Button variant="primary" @click="$emit('run-now')">{{ $t("autoConfig.missedRuns.runNow") }}</Button>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { useI18n } from "@kabegame/i18n";
import { Button, Dialog } from "@/components/ui";
import type { MissedRunItem } from "@/stores/crawler";

defineProps<{
  open: boolean;
  items: MissedRunItem[];
  /** 触发来源为「系统休眠期间漏跑」时为 true，用于切换提示文案 */
  systemSleep?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  "run-now": [];
  dismiss: [];
}>();

const { t } = useI18n();

// 点 × / Esc / 返回键关闭 = 稍后再说（原 before-close 也是先 dismiss 再关）；点遮罩不关
function onUpdateOpen(value: boolean) {
  if (value) return;
  emit("dismiss");
  emit("close");
}

const modeText = (mode: MissedRunItem["scheduleMode"]) => {
  if (mode === "interval") return t("autoConfig.modeInterval");
  if (mode === "hourly") return t("autoConfig.modeHourly");
  if (mode === "daily") return t("autoConfig.modeDaily");
  if (mode === "weekly") return t("autoConfig.modeWeekly");
  return t("autoConfig.unset");
};

const formatTime = (ts: number) => {
  const ms = ts > 9_999_999_999 ? ts : ts * 1000;
  return new Date(ms).toLocaleString();
};
</script>
