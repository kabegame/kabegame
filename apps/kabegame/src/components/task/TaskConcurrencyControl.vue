<template>
  <div
    class="flex h-16px min-w-0 items-center gap-1 text-11px leading-16px text-[var(--anime-text-secondary)]"
    :title="tooltip"
  >
    <button
      v-if="editable"
      type="button"
      class="h-16px w-16px flex flex-none items-center justify-center border-0 rounded-3px bg-transparent p-0 text-[var(--anime-text-muted)] hover:bg-[var(--anime-bg-hover)] hover:text-[var(--anime-primary)] disabled:cursor-not-allowed disabled:opacity-35"
      :aria-label="t('common.decrease')"
      :disabled="busy || effective <= 1"
      @click.stop="update(decreasedTaskConcurrency(effective))"
    >
      <Minus class="h-10px w-10px" />
    </button>
    <span class="whitespace-nowrap tabular-nums">
      {{ t("tasks.drawerConcurrency", { active: inFlight, limit: effective }) }}
    </span>
    <span v-if="limit == null" class="text-[var(--anime-text-muted)]">
      · {{ t("tasks.taskRunParamsFollowGlobal") }}
    </span>
    <button
      v-if="editable"
      type="button"
      class="h-16px w-16px flex flex-none items-center justify-center border-0 rounded-3px bg-transparent p-0 text-[var(--anime-text-muted)] hover:bg-[var(--anime-bg-hover)] hover:text-[var(--anime-primary)] disabled:cursor-not-allowed disabled:opacity-35"
      :aria-label="t('common.increase')"
      :disabled="busy || limit == null"
      @click.stop="update(increasedTaskConcurrency(effective, globalMax))"
    >
      <Plus class="h-10px w-10px" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Minus, Plus } from "@kabegame/element-plus-icons";
import { useCrawlerStore } from "@/stores/crawler";
import { useSettingsStore } from "@/stores/settings";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { decreasedTaskConcurrency, effectiveTaskConcurrency, increasedTaskConcurrency } from "./taskConcurrency";

const props = defineProps<{
  taskId: string;
  limit: number | null;
  inFlight: number;
  editable: boolean;
}>();

const { t } = useI18n();
const crawlerStore = useCrawlerStore();
const settingsStore = useSettingsStore();
const busy = ref(false);
const globalMax = computed(() => Math.max(1, Number(settingsStore.values.maxConcurrentDownloads) || 1));
const effective = computed(() => effectiveTaskConcurrency(props.limit, globalMax.value));
const tooltip = computed(() =>
  props.limit == null
    ? t("tasks.drawerConcurrencyFollowGlobal", { n: globalMax.value })
    : t("tasks.drawerConcurrencyCustom", { n: props.limit }),
);

async function update(value: number | null) {
  if (busy.value) return;
  busy.value = true;
  try {
    await crawlerStore.setTaskMaxConcurrentDownloads(props.taskId, value);
  } catch (error) {
    console.error("更新任务并发失败:", error);
    ElMessage.error(t("tasks.concurrencyUpdateFailed"));
  } finally {
    busy.value = false;
  }
}
</script>
