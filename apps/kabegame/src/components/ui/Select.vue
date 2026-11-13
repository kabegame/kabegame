<template>
  <SelectRoot v-model="model" v-model:open="open" :disabled="disabled">
    <SelectTrigger
      :id="field.id.value"
      :aria-invalid="field.invalid.value || undefined"
      :aria-describedby="field.describedBy.value"
      :data-invalid="field.invalid.value || undefined"
      :class="[
        'kb-control cursor-pointer justify-between gap-2 px-2.5 outline-none [font:inherit] text-left data-[placeholder]:text-kb-fg-subtle',
        size === 'sm' ? 'h-7 text-[12.5px]' : 'h-8',
      ]"
    >
      <span class="min-w-0 flex-1 truncate">
        <SelectValue :placeholder="placeholder">
          <slot name="value" :option="selected">{{ selected?.label }}</slot>
        </SelectValue>
      </span>
      <ChevronDown
        class="size-4 shrink-0 text-kb-fg-subtle transition-transform duration-150"
        :class="open ? 'rotate-180' : ''"
      />
    </SelectTrigger>
    <SelectPortal :to="portalTo">
      <SelectContent
        position="popper"
        :side-offset="4"
        :collision-padding="8"
        class="kb-menu-panel max-h-[min(var(--reka-select-content-available-height),320px)] min-w-[var(--reka-select-trigger-width)]"
        :style="{ zIndex }"
        @focus-outside="keepOpenOnForeign"
        @interact-outside="keepOpenOnForeign"
      >
        <SelectViewport>
          <SelectItem
            v-for="option in options"
            :key="String(option.value)"
            :value="option.value"
            :disabled="option.disabled"
            class="kb-menu-item pr-8"
          >
            <SelectItemText>
              <slot name="option" :option="option">{{ option.label }}</slot>
            </SelectItemText>
            <SelectItemIndicator class="absolute right-2.5 inline-flex">
              <Check class="!text-kb-fg" />
            </SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>

<script setup lang="ts" generic="T extends string | number">
/**
 * 下拉选择（v-model 选中的值）。options 给选项；#option 自定义选项行、#value 自定义已选显示。
 * 要搜索时用 Combobox。
 */
import { computed, ref, watch } from "vue";
import {
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from "reka-ui";
import { Check, ChevronDown } from "@lucide/vue";
import { useModalBack } from "@/composables/useModalBack";
import { foreignPortalTarget, keepOpenOnForeign, useLayerZIndex, usePauseForeignTraps } from "./compat";
import { useFieldControl } from "./field";

export interface SelectOption<V> {
  label: string;
  value: V;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    options: SelectOption<T>[];
    placeholder?: string;
    disabled?: boolean;
    invalid?: boolean;
    id?: string;
    size?: "sm" | "md";
  }>(),
  { size: "md" },
);

const model = defineModel<T>();
const open = ref(false);
useModalBack(open);
const zIndex = useLayerZIndex(open);
usePauseForeignTraps(open); // TODO:[REF_UI] P9 删
const field = useFieldControl(props);
const selected = computed(() => props.options.find((o) => o.value === model.value));

// TODO:[REF_UI] P9 删：触发器在 EP 对话框里时挂进那个对话框（见 compat.ts）
const portalTo = ref<HTMLElement | undefined>();
watch(open, (value) => {
  if (value) portalTo.value = foreignPortalTarget(document.activeElement);
});
</script>
