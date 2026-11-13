<template>
  <!-- 结构与 RunConfigGridCard 一致：开关位换成导入按钮，定时只读，第三行放描述 -->
  <ConfigGridCard @click="$emit('cardClick')">
    <template #icon>
      <div class="grid size-[34px] flex-none place-items-center overflow-hidden rounded-kb-md bg-kb-fill-light">
        <img v-if="icon" :src="icon" alt="" class="size-6 object-contain" />
        <Puzzle v-else class="size-4 text-kb-fg-subtle" />
      </div>
    </template>
    <template #title>
      <span class="truncate text-[13.5px] font-600 text-kb-fg" :title="title">
        {{ title }}
      </span>
      <span class="truncate text-[11.5px] text-kb-fg-subtle">
        {{ pluginStore.pluginLabel(preset.pluginId) }}
      </span>
    </template>
    <template #action>
      <!-- 已导入是描边按钮（可再导入一份），未导入是主按钮 -->
      <Tooltip :content="imported ? t('autoConfig.importAgain') : undefined">
        <Button :variant="imported ? 'outline' : 'primary'" size="sm" @click="$emit('import')">
          <Check v-if="imported" />
          {{ imported ? t("autoConfig.imported") : t("autoConfig.importRecommended") }}
        </Button>
      </Tooltip>
    </template>
    <template #schedule>
      <span
        class="inline-flex h-6 flex-none items-center gap-1.25 rounded-kb-sm bg-kb-fill-light px-2 text-[12.5px]"
        :class="preset.scheduleSpec ? 'text-kb-fg' : 'text-kb-fg-muted'"
      >
        <Clock class="size-[13px] flex-none text-kb-fg-muted" />
        {{ specShortText(preset.scheduleSpec, t) }}
      </span>
    </template>
    <template #footer>
      <span class="line-clamp-2 min-h-[2lh] leading-[1.55] text-kb-fg-muted" :title="description">
        {{ description || "—" }}
      </span>
    </template>
  </ConfigGridCard>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Check, Clock, Puzzle } from "@lucide/vue";
import { Button, Tooltip } from "@/components/ui";
import { usePluginStore } from "@/stores/plugins";
import type { PluginRecommendedPreset } from "@/stores/crawler";
import { specShortText } from "@/utils/scheduleText";
import ConfigGridCard from "./ConfigGridCard.vue";

const props = defineProps<{
  preset: PluginRecommendedPreset;
  title: string;
  description?: string;
  imported?: boolean;
}>();
defineEmits<{ cardClick: []; import: [] }>();
const { t } = useI18n();
const pluginStore = usePluginStore();
const icon = computed(() => pluginStore.pluginIconSrc(props.preset.pluginId));
</script>
