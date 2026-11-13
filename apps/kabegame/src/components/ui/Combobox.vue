<template>
  <ComboboxRoot v-model="model" v-model:open="open" :disabled="disabled" :ignore-filter="!!filter">
    <ComboboxAnchor
      :class="['kb-control', size === 'sm' ? 'h-7 text-[12.5px]' : 'h-8']"
      :data-invalid="field.invalid.value || undefined"
    >
      <Search v-if="searchIcon" class="ml-2.5 size-4 shrink-0 text-kb-fg-subtle" />
      <ComboboxInput
        v-model="searchTerm"
        :id="field.id.value"
        :placeholder="placeholder"
        :display-value="displayValue"
        :aria-invalid="field.invalid.value || undefined"
        :aria-describedby="field.describedBy.value"
        class="h-full min-w-0 flex-1 border-0 bg-transparent px-2.5 text-inherit outline-none [font:inherit] placeholder:text-kb-fg-subtle"
        @focus="open = true"
      />
      <ComboboxTrigger
        class="grid h-full w-7 shrink-0 cursor-pointer place-items-center border-0 bg-transparent p-0 text-kb-fg-subtle"
      >
        <ChevronDown class="size-4 transition-transform duration-150" :class="open ? 'rotate-180' : ''" />
      </ComboboxTrigger>
    </ComboboxAnchor>
    <ComboboxPortal :to="portalTo">
      <ComboboxContent
        position="popper"
        :side-offset="4"
        :collision-padding="8"
        class="kb-menu-panel max-h-[min(var(--reka-combobox-content-available-height),320px)] min-w-[var(--reka-combobox-trigger-width)] overflow-y-auto"
        :style="{ zIndex }"
        @focus-outside="keepOpenOnForeign"
        @interact-outside="keepOpenOnForeign"
      >
        <ComboboxViewport>
          <ComboboxEmpty class="px-2.5 py-2 text-[12.5px] text-kb-fg-subtle">
            <slot name="empty">{{ emptyText ?? t("common.noData") }}</slot>
          </ComboboxEmpty>
          <ComboboxItem
            v-for="option in visibleOptions"
            :key="String(option.value)"
            :value="option.value"
            :text-value="option.label"
            :disabled="option.disabled"
            class="kb-menu-item pr-8"
          >
            <slot name="option" :option="option">
              <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
            </slot>
            <ComboboxItemIndicator class="absolute right-2.5 inline-flex">
              <Check class="!text-kb-fg" />
            </ComboboxItemIndicator>
          </ComboboxItem>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>

<script setup lang="ts" generic="T extends string | number">
/**
 * 可搜索的选择（v-model 选中的值）：输入框里打字过滤选项（默认按标签包含、不分大小写），
 * 方向键选、回车确认。filter 可换成自己的匹配；v-model:search-term 拿到输入的文字（远程搜索）。
 * 地址栏那种「可以不选、直接用输入的文字」的补全在用到时（P6）再加。
 */
import { computed, ref, watch } from "vue";
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
} from "reka-ui";
import { Check, ChevronDown, Search } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { useModalBack } from "@/composables/useModalBack";
import { foreignPortalTarget, keepOpenOnForeign, useLayerZIndex, usePauseForeignTraps } from "./compat";
import { useFieldControl } from "./field";

interface ComboboxOption<V> {
  label: string;
  value: V;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    options: ComboboxOption<T>[];
    placeholder?: string;
    emptyText?: string;
    disabled?: boolean;
    /** 自定义匹配；不给时由 Reka 按标签包含过滤 */
    filter?: (option: ComboboxOption<T>, term: string) => boolean;
    searchIcon?: boolean;
    invalid?: boolean;
    id?: string;
    size?: "sm" | "md";
  }>(),
  { size: "md" },
);

const model = defineModel<T>();
const searchTerm = defineModel<string>("searchTerm", { default: "" });
const { t } = useI18n();
const open = ref(false);
useModalBack(open);
const zIndex = useLayerZIndex(open);
usePauseForeignTraps(open); // TODO:[REF_UI] P9 删
const field = useFieldControl(props);

const visibleOptions = computed(() =>
  props.filter ? props.options.filter((o) => props.filter!(o, searchTerm.value)) : props.options,
);
const displayValue = (value: unknown) => props.options.find((o) => o.value === value)?.label ?? "";

// TODO:[REF_UI] P9 删：输入框在 EP 对话框里时挂进那个对话框（见 compat.ts）
const portalTo = ref<HTMLElement | undefined>();
watch(open, (value) => {
  if (value) portalTo.value = foreignPortalTarget(document.activeElement);
});
</script>
