<template>
  <!-- 外观与 ui/SegmentedControl 一致；多出单项说明（tip）与「置灰但仍能悬停看原因」 -->
  <div
    role="radiogroup"
    class="box-border flex h-8 min-w-0 max-w-full flex-nowrap items-center gap-0.5 overflow-x-auto overscroll-x-contain rounded-kb-md bg-kb-fill p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    :class="disabled ? 'opacity-60' : ''"
  >
    <!-- 选项放不下时横向滚动而不是换行：换行会把控件撑成两行，同一栅格行里的邻居字段就参差不齐 -->
    <template v-for="opt in options" :key="String(opt.value)">
      <!-- 不可选的选项不加原生 disabled：那样悬停事件到不了它，说明就弹不出来 -->
      <Tooltip :content="opt.tip" side="top" :delay="200">
        <button
          type="button"
          role="radio"
          :aria-checked="opt.value === modelValue"
          :aria-disabled="opt.disabled || disabled ? 'true' : undefined"
          :disabled="disabled"
          :title="opt.tip ? undefined : opt.label"
          class="box-border inline-flex h-7 flex-none cursor-pointer items-center justify-center whitespace-nowrap rounded-[6px] border-0 px-3 py-0 text-[12.5px] [font-family:inherit] leading-none outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-kb-ring disabled:cursor-not-allowed"
          :class="[
            opt.value === modelValue
              ? 'bg-kb-surface-raised font-600 text-kb-fg shadow-kb-sm'
              : 'bg-transparent font-500 text-kb-fg-muted',
            opt.disabled ? 'cursor-not-allowed opacity-45' : opt.value === modelValue ? '' : 'hover:text-kb-fg',
          ]"
          @click="onSelect(opt)"
        >
          {{ opt.label }}
        </button>
      </Tooltip>
    </template>
  </div>
</template>

<script setup lang="ts">
import Tooltip from "@/components/ui/Tooltip.vue";

type Option = {
  label: string;
  value: string;
  /** 这一项不可选：置灰、点了没反应（整组的 `disabled` 另算） */
  disabled?: boolean;
  /** 悬停说明；不可选的项用它写原因。给了就不再用选项名作原生 title */
  tip?: string;
};

const props = defineProps<{
  modelValue: string;
  options: Option[];
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

function onSelect(option: Option) {
  if (props.disabled || option.disabled || option.value === props.modelValue) return;
  emit("update:modelValue", option.value);
}
</script>
