<template>
  <!-- 空槽：只占位不画任何东西，让同一枚标签在列表各行落在同一列 -->
  <span v-if="!label" class="kb-label-empty flex-none" :class="sizeClass" aria-hidden="true" />

  <!-- 触屏没有悬停：Android 点一下弹出同样的说明（Reka 的 Tooltip 不响应点按） -->
  <Popover v-else-if="IS_ANDROID && resolved.desc">
    <PopoverTrigger as-child>
      <button
        type="button"
        :class="[TILE_CLASS, sizeClass]"
        class="cursor-pointer p-0"
        :style="tileStyle"
        :aria-label="tooltipText"
      >
        <component :is="resolved.icon" v-if="resolved.icon" :class="iconClass" />
        <span v-else class="font-700 text-kb-fg-subtle" :class="fallbackTextClass">{{ fallbackChar }}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" :width="240">
      <p class="m-0 px-1.5 py-1 text-[12.5px] leading-[1.6] text-kb-fg-muted">{{ tooltipText }}</p>
    </PopoverContent>
  </Popover>

  <Tooltip v-else :content="resolved.desc ? tooltipText : ''" side="top" :delay="200">
    <span :class="[TILE_CLASS, sizeClass]" :style="tileStyle" role="img" :aria-label="tooltipText" tabindex="0">
      <component :is="resolved.icon" v-if="resolved.icon" :class="iconClass" />
      <span v-else class="font-700 text-kb-fg-subtle" :class="fallbackTextClass">{{ fallbackChar }}</span>
    </span>
  </Tooltip>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { PopoverTrigger } from "reka-ui";
import { Popover, PopoverContent, Tooltip } from "@/components/ui";
import { useI18n } from "@kabegame/i18n";
import { IS_ANDROID } from "@/env";
import { resolvePluginLabel, type PluginLabel, type ResolvedPluginLabel } from "../../stores/pluginLabels";

const props = withDefaults(
  defineProps<{
    /** 传 null 渲染等宽空槽——固定槽位布局里插件缺这枚标签时用 */
    label: PluginLabel | null;
    size?: "small" | "default" | "large";
  }>(),
  { size: "small" },
);

const { t } = useI18n();

const TILE_CLASS =
  "kb-label inline-flex flex-none box-border items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-kb-ring";

const EMPTY: ResolvedPluginLabel = { text: "", desc: "" };

const resolved = computed(() =>
  props.label ? resolvePluginLabel(props.label, t as (k: string, params?: Record<string, unknown>) => string) : EMPTY,
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
    : { background: "var(--kb-fill-light)", border: "1px dashed var(--kb-line-strong)" };
});
</script>
