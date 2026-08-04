<template>
  <!-- 空槽：只占位不画任何东西，让同一枚标签在列表各行落在同一列 -->
  <span v-if="!label" class="kb-label-empty flex-none" :class="sizeClass" aria-hidden="true" />

  <el-tooltip v-else placement="top" :show-after="200" :disabled="!resolved.desc">
    <template #content>{{ tooltipText }}</template>
    <span
      class="kb-label inline-flex items-center justify-center flex-none box-border"
      :class="sizeClass"
      :style="tileStyle"
      role="img"
      :aria-label="tooltipText"
      tabindex="0"
    >
      <component :is="resolved.icon" v-if="resolved.icon" :class="iconClass" />
      <span v-else class="font-700 text-[#909399]" :class="fallbackTextClass">{{ fallbackChar }}</span>
    </span>
  </el-tooltip>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ElTooltip } from "@kabegame/element-plus";
import { useI18n } from "@kabegame/i18n";
import {
  resolvePluginLabel,
  type PluginLabel,
  type ResolvedPluginLabel,
} from "../../stores/pluginLabels";

const props = withDefaults(
  defineProps<{
    /** 传 null 渲染等宽空槽——固定槽位布局里插件缺这枚标签时用 */
    label: PluginLabel | null;
    size?: "small" | "default" | "large";
  }>(),
  { size: "small" },
);

const { t } = useI18n();

const EMPTY: ResolvedPluginLabel = { text: "", desc: "" };

const resolved = computed(() =>
  props.label
    ? resolvePluginLabel(props.label, t as (k: string, params?: Record<string, unknown>) => string)
    : EMPTY,
);

const tooltipText = computed(() =>
  resolved.value.desc ? `${resolved.value.text} · ${resolved.value.desc}` : resolved.value.text,
);

// 未命中 registry 的未知标签取 name 首字符，无 name 时取 id 末段首字符
const fallbackChar = computed(() => {
  if (!props.label) return "";
  const base = props.label.name || props.label.id.split(".").pop() || props.label.id;
  return base.charAt(0);
});

// 方块 = 图标 × 1.5，圆角 = 方块 × 0.3（KbLabel 设计稿 1b）
const sizeClass = computed(() => {
  switch (props.size) {
    case "large":
      return "w-36px h-36px rounded-11px";
    case "default":
      return "w-30px h-30px rounded-9px";
    default:
      return "w-24px h-24px rounded-7px";
  }
});

const iconClass = computed(() => {
  switch (props.size) {
    case "large":
      return "w-24px h-24px";
    case "default":
      return "w-20px h-20px";
    default:
      return "w-16px h-16px";
  }
});

const fallbackTextClass = computed(() => {
  switch (props.size) {
    case "large":
      return "text-15px";
    case "default":
      return "text-13px";
    default:
      return "text-11px";
  }
});

const tileStyle = computed(() => {
  const tile = resolved.value.tile;
  return tile
    ? { background: tile.bg, border: `1px solid ${tile.border}` }
    : { background: "#f4f4f5", border: "1px dashed rgba(144,147,153,0.6)" };
});
</script>
