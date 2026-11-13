<template>
  <!-- 紧凑端从底部滑出（Android 底部弹层），桌面从右侧滑出 -->
  <Sheet
    :open="modelValue"
    :side="uiStore.isCompact ? 'bottom' : 'right'"
    :size="uiStore.isCompact ? undefined : 400"
    :title="resolvedTitle"
    :hide-close="uiStore.isCompact"
    @update:open="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="flex flex-col gap-2">
      <button
        v-for="opt in options"
        :key="opt.id"
        type="button"
        class="group box-border flex w-full cursor-pointer select-none items-center gap-3.5 rounded-kb-lg border border-solid border-kb-line-strong bg-transparent p-3.5 text-left [font:inherit] text-kb-fg outline-none transition-[background-color,border-color] duration-150 hover:border-kb-fg-subtle hover:bg-kb-hover active:bg-kb-pressed focus-visible:ring-2 focus-visible:ring-kb-ring"
        @click="handleSelect(opt.id)"
      >
        <span
          class="grid size-11 shrink-0 place-items-center rounded-kb-md bg-kb-fill text-kb-fg-muted [&_svg]:size-[22px]"
        >
          <component :is="opt.icon" />
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="text-[14px] font-600 leading-5">{{ opt.title }}</span>
          <span v-if="opt.desc" class="text-[12.5px] leading-[1.45] text-kb-fg-muted">{{ opt.desc }}</span>
        </span>
        <ChevronRight
          class="size-4 shrink-0 text-kb-fg-subtle transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-kb-fg-muted"
        />
      </button>
    </div>
  </Sheet>
</template>

<script setup lang="ts">
import type { Component } from "vue";
import { computed } from "vue";
import { ChevronRight } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { Sheet } from "@/components/ui";
import { useUiStore } from "../../stores/ui";

export interface OptionItem {
  id: string;
  title: string;
  desc?: string;
  icon: Component;
}

interface Props {
  modelValue: boolean;
  title?: string;
  options: OptionItem[];
}

const props = withDefaults(defineProps<Props>(), {
  title: undefined,
});
const { t } = useI18n();
const resolvedTitle = computed(() => props.title ?? t("common.selectPlaceholder"));

const uiStore = useUiStore();

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "select", id: string): void;
}>();

const handleSelect = (id: string) => {
  emit("select", id);
};
</script>
