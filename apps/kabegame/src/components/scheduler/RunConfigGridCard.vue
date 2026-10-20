<template>
  <ConfigGridCard
    :failed="config.lastResult === 'failed'"
    :paused="!config.scheduleEnabled"
    @click="$emit('cardClick')"
  >
    <template #icon>
      <div
        class="flex size-[34px] flex-none items-center justify-center overflow-hidden rounded-[10px] bg-[var(--anime-bg-secondary)]"
      >
        <img v-if="icon" :src="icon" alt="" class="size-6 object-contain" />
        <el-icon v-else class="text-base text-[var(--anime-primary)]"><Grid /></el-icon>
      </div>
    </template>
    <template #title>
      <span class="truncate text-[13.5px] font-semibold text-[var(--anime-text-primary)]" :title="config.name">
        {{ config.name }}
      </span>
      <span class="truncate text-[11.5px] text-[var(--anime-text-muted)]">
        {{ pluginStore.pluginLabel(config.pluginId) }}
        <span
          v-if="config.isDryRun"
          class="ml-1 rounded bg-[var(--el-color-warning-light-9)] px-1 text-[10.5px] text-[var(--el-color-warning)]"
        >
          {{ t("autoConfig.dryRunTag") }}
        </span>
      </span>
    </template>
    <template #action>
      <el-switch
        :model-value="config.scheduleEnabled"
        :loading="scheduleTogglingId === config.id"
        :disabled="!config.scheduleSpec"
        size="small"
        @update:model-value="$emit('scheduleEnabled', !!$event)"
      />
    </template>

    <template #schedule>
      <ScheduleEditorPopover :config="config" @updated="$emit('configUpdated', $event)">
        <button
          type="button"
          class="inline-flex flex-none cursor-pointer items-center gap-1.25 rounded-lg border border-dashed border-[var(--anime-border)] bg-transparent px-2 py-0.5 text-[12.5px] text-[var(--anime-text-primary)] hover:border-solid hover:border-[var(--anime-primary)] hover:text-[var(--anime-primary-dark)]"
          :class="{ 'text-[var(--anime-text-muted)]': !config.scheduleSpec }"
        >
          <el-icon class="text-[13px] text-[var(--anime-text-secondary)]"><Clock /></el-icon>
          {{ specShortText(config.scheduleSpec, t) }}
        </button>
      </ScheduleEditorPopover>
      <span class="min-w-0 truncate text-[var(--anime-text-muted)]">
        <template v-if="nextRunAt">
          {{ t("autoConfig.nextShort") }}
          <b class="font-medium text-[var(--anime-text-primary)]">{{ formatRunTime(nextRunAt, t) }}</b>
          · {{ relTime(nextRunAt, t) }}
        </template>
        <template v-else-if="!config.scheduleSpec">{{ t("autoConfig.manualOnly") }}</template>
        <template v-else-if="!config.scheduleEnabled">{{ t("autoConfig.paused") }}</template>
        <template v-else>{{ t("autoConfig.notScheduled") }}</template>
      </span>
    </template>

    <template #footer>
      <span
        class="inline-flex flex-none items-center gap-1.25 rounded-full px-1.75 leading-[19px]"
        :class="resultClass"
      >
        <i v-if="config.lastResult !== 'never'" class="size-1.5 rounded-full bg-current" />
        {{ resultText }}
      </span>
      <template v-if="config.lastTask">
        <span class="flex-none text-[var(--anime-text-muted)]">{{ formatRunTime(config.lastTask.startTime, t) }}</span>
        <span
          v-if="config.lastResult === 'failed' && config.lastTask.error"
          class="min-w-0 flex-1 truncate text-[var(--el-color-danger)]"
          :title="config.lastTask.error"
        >
          {{ config.lastTask.error }}
        </span>
        <template v-else>
          <span class="flex-none text-[var(--anime-text-muted)]">
            {{ t("autoConfig.addedImages", { n: config.lastTask.successCount }) }}
          </span>
          <span class="flex-1" />
        </template>
      </template>
      <span v-else class="flex-1" />
      <button
        type="button"
        class="grid size-[26px] flex-none cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-[var(--anime-text-secondary)] hover:bg-[color-mix(in_srgb,var(--anime-primary)_14%,transparent)] hover:text-[var(--anime-primary-dark)]"
        :title="t('autoConfig.runNow')"
        :aria-label="t('autoConfig.runNow')"
        @click.stop="$emit('run')"
      >
        <el-icon class="text-sm"><VideoPlay /></el-icon>
      </button>
    </template>
  </ConfigGridCard>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Clock, Grid, VideoPlay } from "@kabegame/element-plus-icons";
import { usePluginStore } from "@/stores/plugins";
import type { RunConfig } from "@/stores/crawler";
import { formatRunTime, relTime, specShortText } from "@/utils/scheduleText";
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
// planned_at 后端存秒；兼容历史上可能出现的毫秒值
const nextRunAt = computed(() => {
  const planned = props.config.schedulePlannedAt;
  if (!props.config.scheduleEnabled || !planned) return null;
  return planned > 9_999_999_999 ? planned : planned * 1000;
});
const resultText = computed(() => t(`autoConfig.lastResult_${props.config.lastResult}`));
const resultClass = computed(() => {
  switch (props.config.lastResult) {
    case "ok":
      return "bg-[var(--el-color-success-light-9)] text-[var(--el-color-success)]";
    case "failed":
      return "bg-[var(--el-color-danger-light-9)] text-[var(--el-color-danger)]";
    case "partial":
      return "bg-[var(--el-color-warning-light-9)] text-[var(--el-color-warning)]";
    case "running":
      return "bg-[var(--el-color-primary-light-9)] text-[var(--el-color-primary)]";
    default:
      return "border border-dashed border-[var(--anime-border)] text-[var(--anime-text-muted)]";
  }
});
</script>
