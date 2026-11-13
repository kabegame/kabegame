<template>
  <div class="flex h-16px min-w-0 items-center gap-1 text-11px leading-16px text-kb-fg-muted" :title="tooltip">
    <button
      v-if="editable"
      type="button"
      :class="STEP_BUTTON"
      :aria-label="t('common.decrease')"
      :disabled="busy || effective <= 1"
      @click.stop="update(decreasedTaskConcurrency(effective))"
    >
      <Minus class="size-2.5" />
    </button>
    <span class="whitespace-nowrap tabular-nums">
      {{ t("tasks.drawerConcurrency", { active: inFlight, limit: effective }) }}
    </span>
    <span v-if="limit == null" class="text-kb-fg-subtle">· {{ t("tasks.taskRunParamsFollowGlobal") }}</span>
    <button
      v-if="editable"
      type="button"
      :class="STEP_BUTTON"
      :aria-label="t('common.increase')"
      :disabled="busy || limit == null"
      @click.stop="update(increasedTaskConcurrency(effective, globalMax))"
    >
      <Plus class="size-2.5" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Minus, Plus } from "@lucide/vue";
import { useCrawlerStore } from "@/stores/crawler";
import { useSettingsStore } from "@/stores/settings";
import { kameMessage } from "@/utils/kameMessage";
import { decreasedTaskConcurrency, effectiveTaskConcurrency, increasedTaskConcurrency } from "./taskConcurrency";
import type { CrawlTask } from "@/stores/crawler";

const props = defineProps<{
  taskId: string;
  limit: number | null;
  inFlight: number;
  editable: boolean;
}>();
const emit = defineEmits<{ (e: "updated", task: CrawlTask): void }>();

const { t } = useI18n();
const crawlerStore = useCrawlerStore();
const settingsStore = useSettingsStore();
const busy = ref(false);

const STEP_BUTTON =
  "box-border flex size-4 flex-none cursor-pointer items-center justify-center rounded-[3px] border-0 bg-transparent p-0 text-kb-fg-subtle hover:bg-kb-hover hover:text-kb-fg disabled:cursor-not-allowed disabled:opacity-35";
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
    const task = await crawlerStore.setTaskMaxConcurrentDownloads(props.taskId, value);
    emit("updated", task);
  } catch (error) {
    console.error("更新任务并发失败:", error);
    kameMessage.error(t("tasks.concurrencyUpdateFailed"));
  } finally {
    busy.value = false;
  }
}
</script>
