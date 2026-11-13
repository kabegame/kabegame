<template>
  <BusyTaskCard
    v-if="task"
    :icon="DatabaseZap"
    :title="t('header.metadataMigrationTitle')"
    :subtitle="pluginName"
    :meta="`${percent}%`"
    :progress="percent"
  >
    <template v-if="iconSrc" #icon>
      <img :src="iconSrc" alt="" class="size-4 rounded-[4px] object-cover" />
    </template>
    {{ task.processed.toLocaleString() }} / {{ task.total.toLocaleString() }}
  </BusyTaskCard>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { DatabaseZap } from "@lucide/vue";
import BusyTaskCard from "./BusyTaskCard.vue";
import { resolveConfigText, useI18n } from "@kabegame/i18n";
import { useMetadataMigrationStore } from "@/stores/metadataMigration";
import { usePluginStore } from "@/stores/plugins";

const props = defineProps<{ pluginId: string }>();
const { t, locale } = useI18n();
const store = useMetadataMigrationStore();
const pluginStore = usePluginStore();
const task = computed(() => store.tasks.get(props.pluginId) ?? null);
const plugin = computed(() => pluginStore.plugins.find((item) => item.id === props.pluginId));
const pluginName = computed(
  () => resolveConfigText(plugin.value?.name as Record<string, string>, locale.value) || props.pluginId,
);
const iconSrc = computed(() => pluginStore.pluginIconSrc(props.pluginId));
const percent = computed(() => {
  const current = task.value;
  if (!current || current.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((current.processed / current.total) * 100)));
});
</script>
