<template>
  <div :class="['relative w-full min-w-0', $attrs.class]" :style="$attrs.style as StyleValue">
    <SelectRoot v-model="model" v-model:open="open" :disabled="disabled">
      <SelectTrigger
        :id="field.id.value"
        :aria-invalid="field.invalid.value || undefined"
        :aria-describedby="field.describedBy.value"
        :data-invalid="field.invalid.value || undefined"
        :class="[
          'kb-control cursor-pointer justify-between gap-2 px-2.5 outline-none [font-family:inherit] text-left data-[placeholder]:text-kb-fg-subtle',
          size === 'sm' ? 'h-7 text-[12.5px]' : 'h-8',
        ]"
        :title="title ?? selected?.label ?? placeholder"
      >
        <span class="min-w-0 flex-1 truncate">
          <SelectValue :placeholder="placeholder">
            <!-- 给了默认插槽 Reka 就不再回退到占位文字，未选时自己显示 -->
            <slot v-if="selected" name="value" :option="selected">{{ selected.label }}</slot>
            <template v-else>{{ placeholder }}</template>
          </SelectValue>
        </span>
        <!-- 可清空时给清空按钮留位置（按钮本身在触发器外：按钮不能嵌在按钮里） -->
        <span v-if="showClear" class="w-5 shrink-0" aria-hidden="true" />
        <ChevronDown
          class="size-4 shrink-0 text-kb-fg-subtle transition-transform duration-150"
          :class="open ? 'rotate-180' : ''"
        />
      </SelectTrigger>
      <button
        v-if="showClear"
        type="button"
        tabindex="-1"
        class="absolute right-7.5 top-1/2 grid size-5 -translate-y-1/2 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-kb-fg-subtle hover:bg-kb-hover hover:text-kb-fg-muted"
        :aria-label="t('common.clear')"
        @click="model = undefined"
      >
        <X class="size-3.5" />
      </button>
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
              :title="option.label"
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
  </div>
</template>

<script setup lang="ts" generic="T extends string | number">
/**
 * 下拉选择（v-model 选中的值）。options 给选项；#option 自定义选项行、#value 自定义已选显示。
 * 要搜索时用 Combobox。clearable 时有值显示清空按钮（清空后 v-model 为 undefined）。
 * 选项值不能是空字符串（Reka 的限制：空串表示「未选」）；需要时由调用方编码（见 KbSelect）。
 * class / style 落在外层容器上。
 */
import { computed, ref, watch, type StyleValue } from "vue";
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
import { Check, ChevronDown, X } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
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
    clearable?: boolean;
    /** 触发器的原生 title；不给时用所选项的文字（窄栅格里会被截断，靠它看全） */
    title?: string;
  }>(),
  { size: "md" },
);

defineOptions({ inheritAttrs: false });

const model = defineModel<T>();
const { t } = useI18n();
const showClear = computed(
  () => props.clearable && !props.disabled && model.value !== undefined && model.value !== null,
);
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
