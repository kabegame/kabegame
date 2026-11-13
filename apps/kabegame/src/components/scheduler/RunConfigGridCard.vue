<template>
  <ConfigGridCard
    :failed="config.lastResult === 'failed'"
    :paused="!config.scheduleEnabled"
    @click="$emit('cardClick')"
  >
    <template #icon>
      <div class="grid size-[34px] flex-none place-items-center overflow-hidden rounded-kb-md bg-kb-fill-light">
        <img v-if="icon" :src="icon" alt="" class="size-6 object-contain" />
        <Puzzle v-else class="size-4 text-kb-fg-subtle" />
      </div>
    </template>
    <template #title>
      <span class="truncate text-[13.5px] font-600 text-kb-fg" :title="config.name">
        {{ config.name }}
      </span>
      <span class="flex min-w-0 items-center gap-1 text-[11.5px] text-kb-fg-subtle">
        <span class="truncate">{{ pluginStore.pluginLabel(config.pluginId) }}</span>
        <Tag v-if="config.isDryRun" tone="warning" size="sm" class="flex-none">{{ t("autoConfig.dryRunTag") }}</Tag>
      </span>
    </template>
    <template #action>
      <Switch
        :model-value="config.scheduleEnabled"
        :disabled="!config.scheduleSpec || scheduleTogglingId === config.id"
        size="sm"
        @update:model-value="$emit('scheduleEnabled', !!$event)"
      />
    </template>

    <template #schedule>
      <ScheduleEditorPopover :config="config" @updated="$emit('configUpdated', $event)">
        <button
          type="button"
          class="inline-flex h-6 flex-none cursor-pointer items-center gap-1.25 rounded-kb-sm border-0 bg-kb-fill-light px-2 py-0 text-[12.5px] [font-family:inherit] transition-colors duration-150 hover:bg-kb-fill data-[state=open]:bg-kb-fill"
          :class="config.scheduleSpec ? 'text-kb-fg' : 'text-kb-fg-muted'"
        >
          <!-- 进度圆盘：扇形为本周期剩余时间占比，从 12 点方向顺时针收缩 -->
          <svg
            v-if="progress.active"
            viewBox="0 0 16 16"
            class="size-[13px] flex-none -rotate-90 text-kb-accent"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="7.25" fill="none" stroke="currentColor" stroke-width="1.5" />
            <circle
              cx="8"
              cy="8"
              r="2.75"
              fill="none"
              stroke="currentColor"
              stroke-width="5.5"
              pathLength="100"
              :stroke-dasharray="`${(1 - progress.percent) * 100} 100`"
            />
          </svg>
          <Clock v-else class="size-[13px] flex-none text-kb-fg-muted" />
          {{ specShortText(config.scheduleSpec, t) }}
        </button>
      </ScheduleEditorPopover>
      <span class="min-w-0 truncate text-kb-fg-subtle">
        <template v-if="nextRunAt">
          {{ t("autoConfig.nextShort") }}
          <b class="font-500 text-kb-fg-regular">{{ formatRunTime(nextRunAt, t) }}</b>
        </template>
        <template v-else-if="!config.scheduleSpec">{{ t("autoConfig.manualOnly") }}</template>
        <template v-else-if="!config.scheduleEnabled">{{ t("autoConfig.paused") }}</template>
        <template v-else>{{ t("autoConfig.notScheduled") }}</template>
      </span>
    </template>

    <template #footer>
      <Tag :tone="resultTone" size="sm" class="flex-none">
        {{ resultText }}
      </Tag>
      <template v-if="config.lastTask">
        <span class="flex-none text-kb-fg-subtle">{{ formatRunTime(config.lastTask.startTime, t) }}</span>
        <span
          v-if="config.lastResult === 'failed' && config.lastTask.error"
          class="min-w-0 flex-1 truncate text-kb-danger"
          :title="config.lastTask.error"
        >
          {{ config.lastTask.error }}
        </span>
        <template v-else>
          <span class="flex-none text-kb-fg-subtle">
            {{ t("autoConfig.addedImages", { n: config.lastTask.successCount }) }}
          </span>
          <span class="flex-1" />
        </template>
      </template>
      <span v-else class="flex-1" />
      <Tooltip :content="t('autoConfig.runNow')">
        <Button variant="ghost" size="icon-sm" :aria-label="t('autoConfig.runNow')" @click.stop="$emit('run')">
          <Play />
        </Button>
      </Tooltip>
    </template>
  </ConfigGridCard>
</template>

<script setup lang="ts">
import { computed, toRef } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Clock, Play, Puzzle } from "@lucide/vue";
import { Button, Switch, Tag, Tooltip } from "@/components/ui";
import { usePluginStore } from "@/stores/plugins";
import type { RunConfig } from "@/stores/crawler";
import { formatRunTime, specShortText } from "@/utils/scheduleText";
import { useScheduleProgress } from "@/composables/useScheduleProgress";
import ConfigGridCard from "./ConfigGridCard.vue";
import ScheduleEditorPopover from "./ScheduleEditorPopover.vue";

const props = defineProps<{ config: RunConfig; scheduleTogglingId?: string | null }>();
defineEmits<{
  cardClick: [];
  scheduleEnabled: [enabled: boolean];
  run: [];
  configUpdated: [config: RunConfig];
}>();
const { t } = useI18n();
const pluginStore = usePluginStore();
const icon = computed(() => pluginStore.pluginIconSrc(props.config.pluginId));
const progress = useScheduleProgress(toRef(props, "config"));
// planned_at 后端存秒；兼容历史上可能出现的毫秒值
const nextRunAt = computed(() => {
  const planned = props.config.schedulePlannedAt;
  if (!props.config.scheduleEnabled || !planned) return null;
  return planned > 9_999_999_999 ? planned : planned * 1000;
});
const resultText = computed(() => t(`autoConfig.lastResult_${props.config.lastResult}`));
const resultTone = computed(() => {
  switch (props.config.lastResult) {
    case "ok":
      return "success" as const;
    case "failed":
      return "danger" as const;
    case "partial":
      return "warning" as const;
    case "running":
      return "accent" as const;
    default:
      return "neutral" as const;
  }
});
</script>
