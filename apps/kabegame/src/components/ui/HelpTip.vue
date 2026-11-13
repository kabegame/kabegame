<template>
  <!-- 触屏没有悬停：点一下弹出同样的说明 -->
  <Popover v-if="IS_ANDROID">
    <PopoverTrigger as-child>
      <button type="button" :class="ICON_BUTTON" :aria-label="content">
        <CircleHelp />
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" :width="260">
      <p class="m-0 px-1.5 py-1 text-[12.5px] leading-[1.6] text-kb-fg-muted">{{ content }}</p>
    </PopoverContent>
  </Popover>
  <Tooltip v-else :content="content" side="top">
    <button type="button" :class="ICON_BUTTON" :aria-label="content">
      <CircleHelp />
    </button>
  </Tooltip>
</template>

<script setup lang="ts">
/**
 * 「?」说明：桌面悬停弹提示，Android 点按弹气泡。表单项、勾选项后面跟一句解释时用，
 * 取代 el-tooltip + QuestionFilled 的写法。
 */
import { PopoverTrigger } from "reka-ui";
import { CircleHelp } from "@lucide/vue";
import { IS_ANDROID } from "@/env";
import Popover from "./Popover.vue";
import PopoverContent from "./PopoverContent.vue";
import Tooltip from "./Tooltip.vue";

defineProps<{ content: string }>();

const ICON_BUTTON =
  "inline-grid size-4 flex-none cursor-help place-items-center rounded-full border-0 bg-transparent p-0 " +
  "text-kb-fg-subtle outline-none transition-colors hover:text-kb-fg-muted focus-visible:ring-2 focus-visible:ring-kb-ring " +
  "[&_svg]:size-3.5";
</script>
