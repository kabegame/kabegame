<template>
  <!-- 固定槽位：每枚内置标签占一列，插件没有的留等宽空位，好让各行同列可纵向对比 -->
  <div v-if="fixedSlots" class="flex gap-1">
    <KbLabel
      v-for="id in PLUGIN_LABEL_IDS"
      :key="id"
      :label="byId.get(id) ?? null"
      :size="size"
    />
  </div>

  <div v-else-if="dedupedSorted.length" class="flex flex-wrap gap-1">
    <KbLabel v-for="label in dedupedSorted" :key="label.id" :label="label" :size="size" />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import KbLabel from "./KbLabel.vue";
import {
  comparePluginLabels,
  PLUGIN_LABEL_IDS,
  type PluginLabel,
} from "../../stores/pluginLabels";

const props = withDefaults(
  defineProps<{
    labels: PluginLabel[];
    size?: "small" | "default" | "large";
    /**
     * 固定槽位模式：按 PLUGIN_LABEL_IDS 逐槽渲染，插件没有的标签留等宽空位，
     * 于是同一枚标签在列表各行落在同一列，扫一眼就能比较各插件有哪些标签。
     * 插件自定义的未知标签没有属于它的槽，该模式下一律不渲染——它只能画成
     * 灰色回落方块，传达不了含义还会把后面的槽整体推移。
     * 详情页等单插件场景不要开（默认 false），那里未知标签仍应展示。
     */
    fixedSlots?: boolean;
  }>(),
  { size: "small", fixedSlots: false },
);

// id 同时用作 :key / 槽位查找键，故先按 id 去重，
// 避免插件重复声明同一标签导致 key 冲突。
const byId = computed(() => {
  const map = new Map<string, PluginLabel>();
  for (const label of props.labels) {
    if (!map.has(label.id)) map.set(label.id, label);
  }
  return map;
});

// 非固定槽位模式：仍按 registry 顺序紧凑排列（见 comparePluginLabels），
// 插件声明顺序、后端合成标签（如 app.versionIncompatible）的追加位置
// 都不该影响展示顺序，否则同一插件在不同入口里标签顺序会跳。
const dedupedSorted = computed(() =>
  [...byId.value.values()].sort(comparePluginLabels),
);
</script>
