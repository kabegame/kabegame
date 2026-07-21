<template>
  <div v-if="resolved.length" class="flex flex-wrap gap-1">
    <el-tooltip
      v-for="item in resolved"
      :key="item.id"
      placement="top"
      :show-after="200"
      :disabled="!item.desc"
    >
      <template #content>{{ item.desc }}</template>
      <el-tag :type="item.type" :size="size" effect="plain">
        {{ item.text }}
      </el-tag>
    </el-tooltip>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import {
  resolvePluginLabel,
  type PluginLabel,
} from "../../stores/pluginLabels";

const props = withDefaults(
  defineProps<{
    labels: PluginLabel[];
    size?: "small" | "default" | "large";
  }>(),
  { size: "small" },
);

const { t } = useI18n();

// 按 id 排序后渲染：插件声明顺序、后端合成标签（如 app.versionIncompatible）的追加位置
// 都不该影响展示顺序，否则同一个插件在不同入口/不同次渲染里标签顺序会跳。
// id 同时用作 :key，故先按 id 去重，避免插件重复声明同一标签导致 key 冲突。
const resolved = computed(() => {
  const byId = new Map<string, PluginLabel>();
  for (const label of props.labels) {
    if (!byId.has(label.id)) byId.set(label.id, label);
  }
  return [...byId.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((label) => ({
      id: label.id,
      ...resolvePluginLabel(
        label,
        t as (k: string, params?: Record<string, unknown>) => string,
      ),
    }));
});
</script>
