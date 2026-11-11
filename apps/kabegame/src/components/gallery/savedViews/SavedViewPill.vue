<template>
  <!-- 收藏视图组合展示里的一颗只读条件：new = 用当前视图更新后新增的，removed = 将被移除的。 -->
  <span
    class="inline-flex h-[22px] max-w-full items-center gap-1 whitespace-nowrap rounded-md border border-solid px-[7px] text-xs"
    :class="variantClass"
    :title="pill.title"
  >
    <component :is="pill.icon" class="h-[13px] w-[13px] flex-none" :class="iconClass" />
    <span class="truncate">{{ pill.label }}</span>
    <!-- 细边框：白色、黑色的色块不会融进 chip 背景 -->
    <span
      v-if="pill.swatch"
      class="box-border h-2.5 w-2.5 flex-none rounded-[3px] border border-solid border-[var(--anime-border)]"
      :style="{ backgroundColor: pill.swatch }"
    />
    <span v-if="pill.swatchLabel" class="truncate">{{ pill.swatchLabel }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { SavedViewPill } from "./savedViewPills";

const props = withDefaults(
  defineProps<{
    pill: SavedViewPill;
    variant?: "normal" | "new" | "removed";
  }>(),
  { variant: "normal" },
);

const variantClass = computed(() => {
  if (props.variant === "new") {
    return "border-[var(--anime-primary)] bg-[color-mix(in_srgb,var(--anime-primary)_16%,var(--anime-bg-card))] text-[var(--anime-text-primary)]";
  }
  if (props.variant === "removed") {
    return "border-[var(--anime-border)] bg-transparent text-[var(--anime-text-secondary)] line-through";
  }
  return "border-[var(--anime-border)] bg-[var(--anime-bg-card)] text-[var(--anime-text-primary)]";
});

const iconClass = computed(() =>
  props.variant === "removed" ? "text-[var(--anime-text-secondary)]" : "text-[var(--anime-primary)]",
);
</script>
