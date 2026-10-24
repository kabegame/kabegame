<template>
  <!-- 结构与 RunConfigGridCard 一致：开关位换成导入按钮，定时只读，第三行放描述 -->
  <ConfigGridCard @click="$emit('cardClick')">
    <template #icon>
      <div
        class="flex size-[34px] flex-none items-center justify-center overflow-hidden rounded-[10px] bg-[var(--anime-bg-secondary)]"
      >
        <img v-if="icon" :src="icon" alt="" class="size-6 object-contain" />
        <el-icon v-else class="text-base text-[var(--anime-primary)]"><Grid /></el-icon>
      </div>
    </template>
    <template #title>
      <span class="truncate text-[13.5px] font-semibold text-[var(--anime-text-primary)]" :title="title">
        {{ title }}
      </span>
      <span class="truncate text-[11.5px] text-[var(--anime-text-muted)]">
        {{ pluginStore.pluginLabel(preset.pluginId) }}
      </span>
    </template>
    <template #action>
      <!-- 已导入改用默认描边按钮：主题下 primary + plain 是粉底浅紫字，几乎看不清 -->
      <el-button
        :type="imported ? 'default' : 'primary'"
        size="small"
        :title="imported ? t('autoConfig.importAgain') : undefined"
        @click="$emit('import')"
      >
        {{ imported ? t("autoConfig.imported") : t("autoConfig.importRecommended") }}
      </el-button>
    </template>
    <template #schedule>
      <span
        class="inline-flex flex-none items-center gap-1.25 rounded-lg border border-solid border-[color-mix(in_srgb,var(--anime-primary)_16%,transparent)] px-2 py-0.5 text-[12.5px]"
        :class="preset.scheduleSpec ? 'text-[var(--anime-text-primary)]' : 'text-[var(--anime-text-muted)]'"
      >
        <el-icon class="text-[13px] text-[var(--anime-text-secondary)]"><Clock /></el-icon>
        {{ specShortText(preset.scheduleSpec, t) }}
      </span>
    </template>
    <template #footer>
      <span class="line-clamp-2 min-h-[2lh] leading-[1.55] text-[var(--anime-text-muted)]" :title="description">
        {{ description || "—" }}
      </span>
    </template>
  </ConfigGridCard>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Clock, Grid } from "@kabegame/element-plus-icons";
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
