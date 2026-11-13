<template>
  <ComboboxRoot
    v-model="selected"
    v-model:open="open"
    multiple
    ignore-filter
    reset-search-term-on-select
    reset-search-term-on-blur
  >
    <ComboboxAnchor
      class="kb-control h-auto min-h-8 cursor-text flex-wrap gap-1 px-1.5 py-1"
      :data-invalid="field.invalid.value || undefined"
      @click="inputRef?.$el?.focus()"
    >
      <!-- 已选项：插件预设的选项实底，用户手打新增的虚线框 -->
      <span
        v-for="(item, idx) in currentList"
        :key="`${item}-${idx}`"
        class="box-border inline-flex h-6 max-w-full items-center gap-1 rounded-kb-sm pl-2 pr-0.5 text-[12px] font-500"
        :class="
          knownValues.has(item)
            ? 'bg-[color-mix(in_srgb,var(--kb-accent)_10%,transparent)] text-kb-fg'
            : 'border border-dashed border-kb-line-strong text-kb-fg-muted'
        "
        :title="labelOf(item)"
      >
        <span class="min-w-0 truncate">{{ labelOf(item) }}</span>
        <button
          type="button"
          tabindex="-1"
          class="grid size-4.5 shrink-0 cursor-pointer place-items-center rounded-[4px] border-0 bg-transparent p-0 text-current opacity-70 hover:bg-kb-hover hover:opacity-100"
          :aria-label="t('common.remove')"
          @click.stop="removeAt(idx)"
        >
          <X class="size-3" />
        </button>
      </span>
      <ComboboxInput
        ref="inputRef"
        v-model="searchTerm"
        :id="field.id.value"
        :aria-invalid="field.invalid.value || undefined"
        :aria-describedby="field.describedBy.value"
        :placeholder="currentList.length ? '' : placeholder"
        class="h-6 min-w-20 flex-1 border-0 bg-transparent px-1 text-inherit outline-none [font:inherit] placeholder:text-kb-fg-subtle"
        @focus="open = true"
        @keydown.backspace="onBackspace"
      />
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
          <!-- 打的字不在选项里：第一项是「添加」，回车即加（同 el-select 的 allow-create + default-first-option） -->
          <ComboboxItem v-if="createValue" :value="createValue" class="kb-menu-item">
            <Plus />
            <span class="min-w-0 flex-1 truncate">{{ t("common.addCustom", { value: createValue }) }}</span>
          </ComboboxItem>
          <ComboboxItem
            v-for="opt in visibleOptions"
            :key="opt.value"
            :value="opt.value"
            :title="opt.label"
            class="kb-menu-item pr-8"
          >
            <span class="min-w-0 flex-1 truncate">{{ opt.label }}</span>
            <ComboboxItemIndicator class="absolute right-2.5 inline-flex">
              <Check class="!text-kb-fg" />
            </ComboboxItemIndicator>
          </ComboboxItem>
          <div v-if="!createValue && visibleOptions.length === 0" class="px-2.5 py-2 text-[12.5px] text-kb-fg-subtle">
            {{ t("common.noData") }}
          </div>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>

<script setup lang="ts">
/**
 * 多值列表（插件变量 list 型）：已选项排成标签，输入框里打字筛选预设选项；
 * 打的字不在选项里时可直接回车添加。再点一次已选的选项即取消（Combobox 多选的语义）。
 */
import { computed, ref, watch } from "vue";
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxViewport,
} from "reka-ui";
import { Check, Plus, X } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { useModalBack } from "@/composables/useModalBack";
import { foreignPortalTarget, keepOpenOnForeign, useLayerZIndex, usePauseForeignTraps } from "@/components/ui/compat";
import { useFieldControl } from "@/components/ui/field";

type VarOption = string | { name: string | Record<string, string>; variable: string };

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    options?: VarOption[];
    placeholder?: string;
    allowUnset?: boolean;
  }>(),
  { allowUnset: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: string[]];
}>();

const { t } = useI18n();
const field = useFieldControl({});
const open = ref(false);
const searchTerm = ref("");
const inputRef = ref<{ $el?: HTMLInputElement } | null>(null);
useModalBack(open);
const zIndex = useLayerZIndex(open);
usePauseForeignTraps(open); // TODO:[REF_UI] P9 删

// TODO:[REF_UI] P9 删：输入框在 EP 对话框里时挂进那个对话框（见 compat.ts）
const portalTo = ref<HTMLElement | undefined>();
watch(open, (value) => {
  if (value) portalTo.value = foreignPortalTarget(document.activeElement);
});

function optionLabel(o: VarOption): string {
  if (typeof o === "string") return o;
  if (typeof o.name === "string") return o.name;
  if (o.name && typeof o.name === "object") return (o.name as Record<string, string>).default ?? "";
  return "";
}

const normalizedOptions = computed(() => {
  const opts = props.options || [];
  return opts
    .map((o) => {
      if (typeof o === "string") return { label: o, value: o };
      return { label: optionLabel(o), value: o.variable };
    })
    .filter((o) => typeof o.value === "string" && (o.value as string).trim() !== "");
});

const currentList = computed<string[]>(() => {
  return Array.isArray(props.modelValue)
    ? (props.modelValue as unknown[]).map((x) => `${x}`.trim()).filter(Boolean)
    : [];
});

/** 区分「插件预设选项」与「用户手打新增」，后者用虚线标出 */
const knownValues = computed(() => new Set(normalizedOptions.value.map((o) => o.value)));
const labelOf = (value: string) => normalizedOptions.value.find((o) => o.value === value)?.label ?? value;

/** Combobox 多选的 v-model：去重后写回 */
const selected = computed<string[]>({
  get: () => currentList.value,
  set: (next) => {
    const seen = new Set<string>();
    const list = next.map((v) => `${v}`.trim()).filter((v) => v && !seen.has(v) && seen.add(v));
    emit("update:modelValue", list);
  },
});

const visibleOptions = computed(() => {
  const term = searchTerm.value.trim().toLowerCase();
  if (!term) return normalizedOptions.value;
  return normalizedOptions.value.filter(
    (o) => o.label.toLowerCase().includes(term) || o.value.toLowerCase().includes(term),
  );
});

/** 打的字既不是某个选项、也还没加过时，可作为新值添加 */
const createValue = computed(() => {
  const term = searchTerm.value.trim();
  if (!term) return "";
  const exists = normalizedOptions.value.some((o) => o.value === term || o.label === term);
  return exists || currentList.value.includes(term) ? "" : term;
});

function removeAt(index: number) {
  const next = currentList.value.slice();
  next.splice(index, 1);
  emit("update:modelValue", next);
}

/** 输入框为空时退格删掉最后一项 */
function onBackspace() {
  if (searchTerm.value === "" && currentList.value.length > 0) removeAt(currentList.value.length - 1);
}
</script>
