<template>
  <Popover v-model:open="open">
    <Tooltip :content="variant === 'sidebar' && !open ? t('header.toolbox') : ''" side="right">
      <PopoverTrigger as-child>
        <button v-if="variant === 'sidebar'" type="button" :class="SIDEBAR_TRIGGER" :aria-label="t('header.toolbox')">
          <Wrench />
        </button>
        <button v-else type="button" :class="COMPACT_TRIGGER">
          <span class="relative">
            <Wrench />
            <CountBadge
              v-if="busyCount > 0 || hasUnseenFailure"
              :count="Math.max(busyCount, 1)"
              :tone="hasUnseenFailure ? 'danger' : 'accent'"
            />
          </span>
          <span class="max-w-full truncate text-[11px] leading-[1.2]">{{ t("header.toolbox") }}</span>
        </button>
      </PopoverTrigger>
    </Tooltip>
    <PopoverContent
      :side="variant === 'sidebar' ? 'right' : 'top'"
      :align="variant === 'sidebar' ? 'end' : 'center'"
      :side-offset="variant === 'sidebar' ? 10 : 6"
      :width="variant === 'sidebar' ? 272 : 288"
    >
      <GlobalToolsList :compact="variant === 'compact'" @close="open = false" @open-settings="handleOpenSettings" />
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { Wrench } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { CountBadge, Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui";
import { useBusyTasks } from "@/composables/useBusyTasks";
import GlobalToolsList from "./GlobalToolsList.vue";

defineProps<{ variant: "sidebar" | "compact" }>();
const emit = defineEmits<{ "open-settings": [] }>();

const { t } = useI18n();
const open = ref(false);
const { count: busyCount, hasUnseenFailure, markFailuresSeen } = useBusyTasks();

watch(open, (value) => {
  if (value) markFailuresSeen();
});

const handleOpenSettings = () => {
  emit("open-settings");
  open.value = false;
};

defineExpose({ close: () => (open.value = false) });

// 侧栏底部的图标按钮，与 App.vue 侧栏导航项同一套尺寸与状态色
const SIDEBAR_TRIGGER =
  "box-border grid size-10 cursor-pointer place-items-center rounded-kb-md border-0 bg-transparent p-0 text-kb-fg-muted " +
  "outline-none transition-colors duration-150 hover:bg-kb-hover hover:text-kb-fg focus-visible:ring-2 focus-visible:ring-kb-ring " +
  "data-[state=open]:bg-kb-pressed data-[state=open]:text-kb-fg [&_svg]:size-5";
// 紧凑端底部 tab 里的一格，与 App.vue 的路由 tab 同排
const COMPACT_TRIGGER =
  "box-border flex size-full min-w-0 cursor-pointer flex-col items-center justify-center gap-1 border-0 bg-transparent px-0.5 py-2 " +
  "[font-family:inherit] text-kb-fg-muted outline-none transition-colors duration-150 data-[state=open]:text-kb-fg [&_svg]:size-[22px]";
</script>
