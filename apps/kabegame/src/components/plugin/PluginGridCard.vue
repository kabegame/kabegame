<template>
  <div
    role="button"
    tabindex="0"
    :class="[
      'plugin-card relative box-border flex h-[136px] cursor-pointer flex-col items-center gap-2.5 rounded-kb-lg border border-solid border-kb-line bg-kb-surface-raised px-2.5 pb-3 pt-4 outline-none',
      'transition-[border-color,box-shadow,transform] duration-150 hover:border-kb-line-strong hover:shadow-kb-md active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-kb-ring',
      cardClass,
    ]"
    @keydown.enter.prevent="($event.currentTarget as HTMLElement).click()"
  >
    <span v-if="updateAvailable" class="absolute right-2.5 top-2.5 size-[7px] rounded-full bg-kb-accent" />
    <div
      class="plugin-card-icon grid size-14 flex-none place-items-center overflow-hidden rounded-[14px] bg-kb-fill-light"
    >
      <img v-if="iconSrc" :src="iconSrc" alt="" class="size-[38px] object-contain" />
      <Spinner v-else-if="iconLoading" :size="18" class="text-kb-fg-subtle" />
      <Puzzle v-else class="size-6 text-kb-fg-subtle" />
    </div>
    <div class="w-full min-w-0 text-center">
      <div class="plugin-card-name truncate text-[13px] font-600 leading-[1.35] text-kb-fg">{{ name }}</div>
      <div class="plugin-card-version mt-[3px] font-mono text-[11px] leading-[1.3] text-kb-fg-subtle">
        v{{ version }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Puzzle } from "@lucide/vue";
import { Spinner } from "@/components/ui";

defineProps<{
  name: string;
  version: string;
  iconSrc?: string | null;
  iconLoading?: boolean;
  /** 已知有更新可用时显示右上角小圆点（无法确定时不显示，不臆测） */
  updateAvailable?: boolean;
  cardClass?: string;
}>();
</script>

<style scoped>
/* 紧凑端：正方形卡片，与 .plugin-grid-android 的 2 列布局配合 */
.plugin-grid-android .plugin-card {
  height: auto;
  aspect-ratio: 1;
  padding: 10px 6px;
}

.plugin-grid-android .plugin-card-icon {
  width: clamp(40px, 52%, 56px);
  height: clamp(40px, 52%, 56px);
}

.plugin-grid-android .plugin-card-name {
  font-size: 12.5px;
}

.plugin-grid-android .plugin-card-version {
  font-size: 10px;
}
</style>
