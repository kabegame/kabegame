<template>
  <Separator
    :orientation="orientation"
    :decorative="decorative"
    class="shrink-0 bg-kb-line"
    :class="orientation === 'vertical' ? 'h-full w-px self-stretch' : 'h-px w-full'"
  />
</template>

<script setup lang="ts">
/** 分隔线（横 / 竖），颜色 --kb-line。 */
import { Separator } from "reka-ui";

withDefaults(defineProps<{ orientation?: "horizontal" | "vertical"; decorative?: boolean }>(), {
  orientation: "horizontal",
  decorative: true,
});
</script>
