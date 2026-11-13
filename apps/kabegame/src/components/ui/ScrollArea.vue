<template>
  <ScrollAreaRoot type="hover" :scroll-hide-delay="600" class="relative overflow-hidden">
    <ScrollAreaViewport ref="viewportRef" class="size-full [border-radius:inherit]" :class="viewportClass">
      <slot />
    </ScrollAreaViewport>
    <ScrollAreaScrollbar
      v-if="orientation !== 'horizontal'"
      orientation="vertical"
      class="flex w-2.5 touch-none select-none p-0.5 transition-colors duration-150"
    >
      <ScrollAreaThumb class="relative flex-1 rounded-full bg-[rgba(29,27,34,0.2)] hover:bg-[rgba(29,27,34,0.32)]" />
    </ScrollAreaScrollbar>
    <ScrollAreaScrollbar
      v-if="orientation !== 'vertical'"
      orientation="horizontal"
      class="flex h-2.5 touch-none select-none flex-col p-0.5 transition-colors duration-150"
    >
      <ScrollAreaThumb class="relative flex-1 rounded-full bg-[rgba(29,27,34,0.2)] hover:bg-[rgba(29,27,34,0.32)]" />
    </ScrollAreaScrollbar>
    <ScrollAreaCorner />
  </ScrollAreaRoot>
</template>

<script setup lang="ts">
/**
 * 细滚动条的滚动区：悬停时出现、停一会儿隐藏，不占布局宽度。尺寸由调用处给（class="h-80"）。
 * 需要拿滚动元素（虚拟列表、滚到某处）时用 ref 的 viewport。
 */
import { computed, ref } from "vue";
import { ScrollAreaCorner, ScrollAreaRoot, ScrollAreaScrollbar, ScrollAreaThumb, ScrollAreaViewport } from "reka-ui";

withDefaults(defineProps<{ orientation?: "vertical" | "horizontal" | "both"; viewportClass?: string }>(), {
  orientation: "vertical",
});

const viewportRef = ref<{ viewportElement?: HTMLElement; $el?: HTMLElement } | null>(null);
const viewport = computed(() => viewportRef.value?.viewportElement ?? viewportRef.value?.$el ?? null);
defineExpose({ viewport });
</script>
