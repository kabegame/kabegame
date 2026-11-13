<template>
  <TooltipProvider :delay-duration="delay" :disabled="!content">
    <TooltipRoot v-model:open="open">
      <TooltipTrigger as-child>
        <slot />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          :side="side"
          :side-offset="6"
          :collision-padding="8"
          :style="{ zIndex }"
          class="max-w-[280px] rounded-kb-sm bg-kb-fg px-2 py-1 text-[12px] leading-4 text-white shadow-kb-sm select-none origin-[var(--reka-popper-transform-origin)] data-[state=delayed-open]:animate-[kb-pop-in_120ms_var(--kb-ease-out)] data-[state=closed]:animate-[kb-pop-out_80ms_ease-in]"
        >
          {{ content }}
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>

<script setup lang="ts">
/**
 * 文字提示：默认插槽是触发元素（as-child，属性合到它身上），content 为空时不弹。
 * 每个提示自带 Provider，用起来不依赖根组件；触屏上 Reka 不会因点按弹出提示。
 */
import { ref } from "vue";
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from "reka-ui";
import { useLayerZIndex } from "./compat";

withDefaults(
  defineProps<{
    content?: string;
    side?: "top" | "right" | "bottom" | "left";
    /** 悬停多久后弹出（毫秒） */
    delay?: number;
  }>(),
  { content: "", side: "bottom", delay: 400 },
);

// 每次弹出取一个层级号：对话框里的提示要压在对话框之上
const open = ref(false);
const zIndex = useLayerZIndex(open);
</script>
