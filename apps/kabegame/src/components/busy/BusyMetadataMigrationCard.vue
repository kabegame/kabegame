<template>
  <article v-if="task" class="busy-task-card border-[rgba(96,165,250,0.26)] bg-[rgba(96,165,250,0.08)]">
    <div class="flex items-center gap-2">
      <img v-if="iconSrc" :src="iconSrc" alt="" class="h-4 w-4 shrink-0 rounded object-cover" />
      <el-icon v-else class="shrink-0 text-[15px] text-[var(--anime-text-secondary)]"><Filter /></el-icon>
      <div class="min-w-0 flex-1 flex flex-col gap-0.5">
        <span class="truncate text-[13px] font-700 text-[var(--anime-text-primary)]">
          {{ t("header.metadataMigrationTitle") }}
        </span>
        <span class="truncate text-xs text-[#8b6b8f]">{{ pluginName }}</span>
      </div>
      <span class="ml-auto shrink-0 font-mono text-xs text-[#8b6b8f]">{{ percent }}%</span>
    </div>
    <div class="busy-bar-track">
      <span class="busy-bar-fill" :style="{ width: `${percent}%` }" />
    </div>
    <div class="font-mono text-xs text-[#8b6b8f]">
      {{ task.processed.toLocaleString() }} / {{ task.total.toLocaleString() }}
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Filter } from "@kabegame/element-plus-icons";
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
