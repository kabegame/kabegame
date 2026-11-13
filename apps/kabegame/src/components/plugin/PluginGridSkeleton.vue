<template>
  <!-- 与 PluginGridCard 同尺寸的占位：加载完成时卡片原位替换，不跳版 -->
  <div class="plugin-grid" :class="{ 'plugin-grid-android': compact }" aria-hidden="true">
    <div
      v-for="i in count"
      :key="i"
      class="box-border flex flex-col items-center gap-2.5 rounded-kb-lg border border-solid border-kb-line bg-kb-surface-raised px-2.5 pb-3 pt-4"
      :class="compact ? 'aspect-square justify-center' : 'h-[136px]'"
    >
      <Skeleton class="size-14 flex-none rounded-[14px]" />
      <Skeleton class="h-3 w-3/5" />
      <Skeleton class="h-2.5 w-1/4" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { Skeleton } from "@/components/ui";

withDefaults(defineProps<{ compact?: boolean; count?: number }>(), { count: 12 });
</script>
